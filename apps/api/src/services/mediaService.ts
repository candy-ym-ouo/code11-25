import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { ItemMedia } from '@prisma/client';
import { prisma } from '../db';
import { AppError, badRequest, notFound, conflict } from '../http/errors';
import { config } from '../config';
import { objectKey, exists, moveIntoPlace, remove, statObject, tmpDir } from '../storage/local';
import { detectFileType, limitForKind } from '../media/sniff';
import { toMediaDto } from '../serializers';
import * as audit from './auditService';
import { itemWithAccess, type FamilyContext } from './permissionService';

export interface ActorMeta {
  ip?: string | null;
  userAgent?: string | null;
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function enqueue(type: 'media_thumbnail' | 'media_waveform' | 'export_build', payload: object, familyId?: string) {
  await prisma.job.create({
    data: { type, payload: payload as never, familyId: familyId ?? null },
  });
}

export async function uploadMedia(
  userId: string,
  ctx: FamilyContext,
  itemId: string,
  file: { path: string; originalname: string; size: number },
  fields: { kind?: string; caption?: string | null; transcript?: string | null },
  meta: ActorMeta,
) {
  const { item, access } = await itemWithAccess(userId, ctx, itemId);
  if (!access.canManageMedia) {
    await fsp.rm(file.path, { force: true });
    throw new AppError('FORBIDDEN', '没有权限为该条目上传媒体');
  }

  const detected = await detectFileType(file.path);
  const limit = limitForKind(detected.kind, config.limits);
  if (file.size > limit) {
    await fsp.rm(file.path, { force: true });
    throw new AppError('FILE_TOO_LARGE', `文件超过 ${Math.round(limit / 1024 / 1024)}MB 上限`);
  }
  if (fields.kind && fields.kind !== detected.kind) {
    await fsp.rm(file.path, { force: true });
    throw badRequest(`文件真实类型是 ${detected.kind}，与声明的 ${fields.kind} 不一致`);
  }

  const sha = await sha256File(file.path);
  const key = objectKey(ctx.familyId, sha, detected.mime);

  if (await exists(key)) {
    await fsp.rm(file.path, { force: true }); // 内容寻址命中：同一份文件不重复占盘
  } else {
    await moveIntoPlace(file.path, key);
  }

  const maxSort = await prisma.itemMedia.aggregate({ where: { itemId }, _max: { sortOrder: true } });
  const isFirstImage = detected.kind === 'image' && !item.coverMediaId;

  const media = await prisma.$transaction(async (tx) => {
    const created = await tx.itemMedia.create({
      data: {
        itemId,
        kind: detected.kind,
        status: 'processing',
        storageKey: key,
        sha256: sha,
        mimeType: detected.mime,
        byteSize: BigInt(file.size),
        originalName: path.basename(file.originalname).slice(0, 200),
        caption: fields.caption ?? null,
        transcript: fields.transcript ?? null,
        sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
        createdBy: userId,
      },
    });
    if (isFirstImage) {
      await tx.item.update({ where: { id: itemId }, data: { coverMediaId: created.id } });
    }
    await tx.job.create({
      data: {
        familyId: ctx.familyId,
        type: detected.kind === 'audio' ? 'media_waveform' : 'media_thumbnail',
        payload: { mediaId: created.id } as never,
      },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'media.upload',
        targetType: 'item',
        targetId: itemId,
        diff: { mediaId: created.id, kind: detected.kind, bytes: file.size, sha256: sha } as never,
        ...meta,
      },
      tx,
    );
    return created;
  });

  return toMediaDto(media, ctx.familyId);
}

export async function listItemMedia(userId: string, ctx: FamilyContext, itemId: string) {
  await itemWithAccess(userId, ctx, itemId);
  const rows = await prisma.itemMedia.findMany({
    where: { itemId, deletedAt: null },
    orderBy: { sortOrder: 'asc' },
  });
  return rows.map((m) => toMediaDto(m, ctx.familyId));
}

export async function updateMedia(
  userId: string,
  ctx: FamilyContext,
  mediaId: string,
  input: { caption?: string | null; transcript?: string | null; sortOrder?: number; setCover?: boolean },
  meta: ActorMeta,
) {
  const media = await loadMediaForUser(userId, ctx, mediaId);
  const { access } = await itemWithAccess(userId, ctx, media.itemId);
  if (!access.canManageMedia) throw new AppError('FORBIDDEN', '没有权限修改该媒体');

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.itemMedia.update({
      where: { id: mediaId },
      data: {
        caption: input.caption === undefined ? undefined : input.caption,
        transcript: input.transcript === undefined ? undefined : input.transcript,
        sortOrder: input.sortOrder ?? undefined,
      },
    });
    if (input.setCover) {
      if (result.kind !== 'image') throw badRequest('只有图片可以设为封面');
      await tx.item.update({ where: { id: media.itemId }, data: { coverMediaId: mediaId } });
    }
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'media.update',
        targetType: 'item',
        targetId: media.itemId,
        diff: { mediaId, fields: Object.keys(input) } as never,
        ...meta,
      },
      tx,
    );
    return result;
  });
  return toMediaDto(updated, ctx.familyId);
}

export async function softDeleteMedia(userId: string, ctx: FamilyContext, mediaId: string, meta: ActorMeta) {
  const media = await loadMediaForUser(userId, ctx, mediaId);
  const { access } = await itemWithAccess(userId, ctx, media.itemId);
  if (!access.canManageMedia) throw new AppError('FORBIDDEN', '没有权限删除该媒体');

  await prisma.$transaction(async (tx) => {
    await tx.itemMedia.update({ where: { id: mediaId }, data: { deletedAt: new Date() } });
    const item = await tx.item.findUniqueOrThrow({ where: { id: media.itemId } });
    if (item.coverMediaId === mediaId) {
      const next = await tx.itemMedia.findFirst({
        where: { itemId: media.itemId, deletedAt: null, kind: 'image' },
        orderBy: { sortOrder: 'asc' },
      });
      await tx.item.update({ where: { id: media.itemId }, data: { coverMediaId: next?.id ?? null } });
    }
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'media.delete',
        targetType: 'item',
        targetId: media.itemId,
        diff: { mediaId } as never,
        ...meta,
      },
      tx,
    );
  });
}

export async function loadMediaForUser(userId: string, ctx: FamilyContext, mediaId: string): Promise<ItemMedia> {
  const media = await prisma.itemMedia.findFirst({
    where: { id: mediaId, deletedAt: null, item: { familyId: ctx.familyId, deletedAt: null } },
  });
  if (!media) throw notFound('媒体不存在');
  await itemWithAccess(userId, ctx, media.itemId);
  return media;
}

export async function mediaFileTarget(media: ItemMedia, variant: 'raw' | 'thumb' | 'waveform' | 'download') {
  const key =
    variant === 'raw'
      ? media.storageKey
      : variant === 'download'
        ? (media.transcodeKey ?? media.storageKey)
        : variant === 'thumb'
          ? (media.thumbKey ?? media.storageKey)
          : media.waveformKey;
  if (!key) throw notFound('该文件还没有可用产物');
  const stat = await statObject(key);
  if (!stat) throw notFound('文件已不存在');
  return { key, size: stat.size, mimeType: variant === 'thumb' && media.thumbKey ? 'image/webp' : variant === 'download' && media.transcodeKey ? 'audio/mpeg' : media.mimeType };
}

export { enqueue };

/**
 * 失败可重试：把处理失败（或疑似卡在 processing）的媒体重新入队。
 * 幂等：同一条媒体已有 queued/running 的对应任务时直接复用，不产生重复任务。
 * 产物 key 全部按 sha256 内容寻址，重新处理只是覆盖写同一份字节，无副作用。
 */
export async function reprocessMedia(
  userId: string,
  ctx: FamilyContext,
  mediaId: string,
  meta: ActorMeta,
) {
  const media = await loadMediaForUser(userId, ctx, mediaId);
  const { access } = await itemWithAccess(userId, ctx, media.itemId);
  if (!access.canManageMedia) throw new AppError('FORBIDDEN', '没有权限操作该媒体');

  const jobType = media.kind === 'audio' ? 'media_waveform' : 'media_thumbnail';
  const { job, media: updated } = await prisma.$transaction(async (tx) => {
    // JSON 精确匹配 payload->>'mediaId'，只去重同一条媒体的同类型任务
    const pendingJobs = await tx.job.findMany({
      where: { familyId: ctx.familyId, type: jobType, status: { in: ['queued', 'running'] } },
      orderBy: { createdAt: 'desc' },
    });
    const activeJob = pendingJobs.find((j) => (j.payload as { mediaId?: string } | null)?.mediaId === mediaId) ?? null;

    const next = await tx.itemMedia.update({
      where: { id: mediaId },
      data: { status: 'processing', lastError: null },
    });

    if (!activeJob) {
      const created = await tx.job.create({
        data: {
          familyId: ctx.familyId,
          type: jobType,
          // 重试重新获得完整的 maxAttempts 次数，而不是沿用旧计数
          attempts: 0,
          payload: { mediaId } as never,
        },
      });
      await audit.record(
        {
          familyId: ctx.familyId,
          actorId: userId,
          action: 'media.reprocess',
          targetType: 'item',
          targetId: media.itemId,
          diff: { mediaId, kind: media.kind } as never,
          ...meta,
        },
        tx,
      );
      return { job: created, media: next };
    }
    return { job: activeJob, media: next };
  });

  return { media: toMediaDto(updated, ctx.familyId), jobId: job.id };
}

export function makeTmpPath(ext: string): string {
  return path.join(tmpDir(), `proc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`);
}

export async function removeStoredKeys(keys: string[]): Promise<void> {
  await Promise.all(keys.map((k) => remove(k).catch(() => undefined)));
}

export async function assertMediaBelongsToFamily(mediaId: string, familyId: string): Promise<ItemMedia> {
  const media = await prisma.itemMedia.findFirst({ where: { id: mediaId, item: { familyId } } });
  if (!media) throw conflict('媒体与家庭不匹配');
  return media;
}
