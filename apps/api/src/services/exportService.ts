import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';
import { CATEGORY_LABELS, ITEM_STATUS_LABELS, VISIBILITY_LABELS, formatAcquired, htmlToText } from '@heirloom/shared';
import type { Job } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../logger';
import { AppError, notFound } from '../http/errors';
import { absOf } from '../storage/local';
import { slugify } from '../utils/crypto';
import * as audit from './auditService';
import type { FamilyContext } from './permissionService';

export interface ActorMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export async function createExportJob(userId: string, ctx: FamilyContext, meta: ActorMeta) {
  const job = await prisma.$transaction(async (tx) => {
    const created = await tx.job.create({
      data: {
        familyId: ctx.familyId,
        type: 'export_build',
        payload: { requestedBy: userId } as never,
      },
    });
    await audit.record(
      {
        familyId: ctx.familyId,
        actorId: userId,
        action: 'export.create',
        targetType: 'job',
        targetId: created.id,
        ...meta,
      },
      tx,
    );
    return created;
  });
  return { jobId: job.id, status: job.status };
}

export async function getExportJob(familyId: string, jobId: string) {
  const job = await prisma.job.findFirst({ where: { id: jobId, familyId, type: 'export_build' } });
  if (!job) throw notFound('导出任务不存在');
  return {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    lastError: job.lastError,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
    downloadUrl: job.status === 'done' ? `/api/v1/families/${familyId}/exports/${job.id}/download` : null,
    result: job.result,
  };
}

export function exportZipPath(familyId: string, jobId: string): string {
  return path.join(config.EXPORT_ROOT, familyId, `${jobId}.zip`);
}

/**
 * 重试失败（或被中断回收）的导出任务。
 * 只有终态 done/failed 可重试：排队/执行中直接 409，避免重复执行；
 * done 时已可下载，不需要重试。重置为全新一次排队，重复执行没有副作用
 * （导出走临时文件 + 原子替换，产物覆盖同名 zip）。
 */
export async function retryExportJob(userId: string, familyId: string, jobId: string, meta: ActorMeta) {
  const job = await prisma.$transaction(async (tx) => {
    const found = await tx.job.findFirst({ where: { id: jobId, familyId, type: 'export_build' } });
    if (!found) throw notFound('导出任务不存在');
    if (found.status === 'queued' || found.status === 'running') {
      throw new AppError('CONFLICT', '导出任务已在执行中，无需重复发起');
    }
    const reset = await tx.job.update({
      where: { id: jobId },
      data: {
        status: 'queued',
        attempts: 0,
        progress: 0,
        result: Prisma.JsonNull,
        lastError: null,
        runAfter: new Date(),
        startedAt: null,
        finishedAt: null,
        lockedAt: null,
      },
    });
    await audit.record(
      {
        familyId,
        actorId: userId,
        action: 'export.retry',
        targetType: 'job',
        targetId: jobId,
        ...meta,
      },
      tx,
    );
    return reset;
  });
  return { jobId: job.id, status: job.status };
}

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return `"${s.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
}

/**
 * 生成全量导出包。产物结构与项目文档 6.9 一致：
 * manifest.json + items.csv + items/*.md + media/原始文件 + media/index.csv，
 * 每份 media 都带 sha256，离线也能校验完整性。
 *
 * 中断安全：先写 <jobId>.tmp-<attempts>，全部写完后再原子 rename 成 <jobId>.zip。
 * 因此任何时候下载到的 zip 都完整；进程中断只留下临时文件（由 storage_gc 清理），
 * 任务被重新执行也不会污染上一次的结果。
 */
export async function buildExportZip(
  job: Job,
  onProgress?: (progress: number) => Promise<void>,
): Promise<{ file: string; items: number; media: number; bytes: number }> {
  const familyId = job.familyId;
  if (!familyId) throw new Error('导出任务缺少 familyId');

  const family = await prisma.family.findUniqueOrThrow({ where: { id: familyId } });
  const items = await prisma.item.findMany({
    where: { familyId, status: { not: 'trashed' } },
    include: {
      media: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } },
      people: { include: { person: true } },
      creator: { select: { displayName: true } },
    },
    orderBy: { sortAt: 'asc' },
  });

  const outPath = exportZipPath(familyId, job.id);
  // 每次执行独立临时名，重跑时不会和上一次中断的残留相互覆盖
  const tmpPath = `${outPath}.tmp-${job.attempts}`;
  await fsp.mkdir(path.dirname(outPath), { recursive: true });

  // 清理同任务往次执行留下的临时文件（正常情况下已被 rename 掉）
  const tmpPrefix = path.basename(outPath); // <jobId>.zip
  const dirEntries = await fsp.readdir(path.dirname(outPath)).catch(() => []);
  for (const name of dirEntries) {
    if (name.startsWith(`${tmpPrefix}.tmp-`) && name !== path.basename(tmpPath)) {
      await fsp.rm(path.join(path.dirname(outPath), name), { force: true }).catch(() => undefined);
    }
  }

  const output = fs.createWriteStream(tmpPath);
  const archive = archiver('zip', { zlib: { level: 6 } });
  const done = new Promise<void>((resolve, reject) => {
    output.on('close', () => resolve());
    archive.on('error', reject);
    output.on('error', reject);
  });
  archive.pipe(output);

  const root = `family-${slugify(family.name)}-${new Date().toISOString().slice(0, 10)}`;
  let mediaTotal = 0;
  let mediaBytes = 0;
  const mediaIndex: string[] = ['itemId,itemTitle,sortOrder,kind,originalName,sha256,bytes,mimeType'];

  const csv: string[] = ['标题,分类,获得时间,时间精度,来源人物,地点,状态,可见性,创建者,媒体数'];
  const total = items.length;

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    const peopleNames = item.people.map((p) => p.person.name).join('、');
    const acquired = formatAcquired({
      acquiredAt: item.acquiredAt,
      acquiredPrecision: item.acquiredPrecision,
      acquiredLabel: item.acquiredLabel,
    });

    csv.push(
      [
        csvCell(item.title),
        csvCell(CATEGORY_LABELS[item.category]),
        csvCell(acquired),
        csvCell(item.acquiredPrecision),
        csvCell(peopleNames),
        csvCell([item.placeProvince, item.placeCity, item.placeText].filter(Boolean).join(' ')),
        csvCell(ITEM_STATUS_LABELS[item.status]),
        csvCell(VISIBILITY_LABELS[item.visibility]),
        csvCell(item.creator.displayName),
        csvCell(item.media.length),
      ].join(','),
    );

    const md: string[] = [
      `# ${item.title}`,
      '',
      `- 分类：${CATEGORY_LABELS[item.category]}`,
      `- 获得时间：${acquired}${item.acquiredNote ? `（${item.acquiredNote}）` : ''}`,
      `- 来源人物：${peopleNames || '未记录'}`,
      `- 地点：${[item.placeProvince, item.placeCity, item.placeText].filter(Boolean).join(' ') || '未记录'}`,
      `- 存放位置：${item.storageLocation ?? '未记录'}`,
      `- 保存状况：${item.condition ?? '未记录'}`,
      `- 可见范围：${VISIBILITY_LABELS[item.visibility]}`,
      '',
      '## 故事',
      '',
      item.storyHtml ? htmlToText(item.storyHtml) : '（暂无）',
      '',
      '## 图片 / 音频 / 文件',
      '',
      ...(item.media.length
        ? item.media.map(
            (m, idx) =>
              `${idx + 1}. \`media/${item.id}/${String(m.sortOrder).padStart(3, '0')}-${m.originalName}\` — ${m.caption ?? m.kind}${m.transcript ? `\n   听写稿：${m.transcript}` : ''}`,
          )
        : ['（暂无）']),
      '',
    ];
    archive.append(md.join('\n'), { name: `${root}/items/${item.id}.md` });

    for (const m of item.media) {
      const abs = absOf(m.storageKey);
      if (!fs.existsSync(abs)) continue;
      mediaTotal += 1;
      mediaBytes += Number(m.byteSize);
      const name = `${String(m.sortOrder).padStart(3, '0')}-${m.originalName}`;
      archive.file(abs, { name: `${root}/media/${item.id}/${name}` });
      mediaIndex.push(
        [item.id, csvCell(item.title), m.sortOrder, m.kind, csvCell(m.originalName), m.sha256, Number(m.byteSize), m.mimeType].join(','),
      );
    }

    if (i % 25 === 0 || i === total - 1) {
      const progress = total === 0 ? 90 : Math.min(90, Math.round(((i + 1) / total) * 90));
      await onProgress?.(progress);
    }
  }

  archive.append(csv.join('\n'), { name: `${root}/items.csv` });
  archive.append(mediaIndex.join('\n'), { name: `${root}/media/index.csv` });
  archive.append(
    [
      '家中物品来历册 · 导出包',
      '',
      `家庭：${family.name}`,
      `导出时间：${new Date().toISOString()}`,
      `条目数：${items.length}`,
      `媒体文件数：${mediaTotal}`,
      '',
      '如何阅读：',
      '1. items.csv 可用 Excel/WPS 打开，是全部条目的总表。',
      '2. items/<条目ID>.md 是每条物品的完整档案（含故事与媒体清单）。',
      '3. media/<条目ID>/ 下是原始文件，文件名前缀是排序号。',
      '4. media/index.csv 记录了每个文件的 sha256，可用以下命令校验：',
      '   shasum -a 256 <文件>      # macOS / Linux',
      '   certutil -hashfile <文件> SHA256   # Windows',
      '',
      '这个导出包不依赖本系统，任何电脑都能离线打开。',
    ].join('\n'),
    { name: `${root}/README.txt` },
  );
  archive.append(
    JSON.stringify(
      {
        app: '家中物品来历册',
        version: 1,
        exportedAt: new Date().toISOString(),
        family: { id: family.id, name: family.name },
        counts: { items: items.length, media: mediaTotal },
        mediaBytes,
        jobId: job.id,
      },
      null,
      2,
    ),
    { name: `${root}/manifest.json` },
  );

  try {
    await archive.finalize();
    await done;
    // 原子替换：rename 在同一文件系统内是原子的，下载方不可能读到半成品 zip
    await fsp.rename(tmpPath, outPath);
  } catch (err) {
    archive.destroy();
    output.destroy();
    await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }

  const stat = await fsp.stat(outPath);
  logger.info({ jobId: job.id, items: items.length, media: mediaTotal, bytes: stat.size }, '导出包生成完成');
  return { file: outPath, items: items.length, media: mediaTotal, bytes: stat.size };
}

