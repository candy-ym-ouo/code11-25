import type { Job } from '@prisma/client';
import type { Dirent } from 'node:fs';
import { config } from '../config';
import { prisma } from '../db';
import { logger } from '../logger';
import { processImage } from '../media/image';
import { processAudio } from '../media/audio';
import { inspectDocument } from '../media/document';
import { absOf, putBuffer, remove } from '../storage/local';
import { makeTmpPath } from '../services/mediaService';
import { buildExportZip } from '../services/exportService';

type Handler = (job: Job, ctx: JobContext) => Promise<Record<string, unknown>>;

export interface JobContext {
  /** 执行过程中回写进度（带执行代号围栏，任务被回收重跑后旧回写自动失效） */
  touchProgress: (progress: number) => Promise<void>;
}

function mediaIdOf(job: Job): string | null {
  const { mediaId } = (job.payload ?? {}) as { mediaId?: unknown };
  return typeof mediaId === 'string' ? mediaId : null;
}

/** 媒体任务彻底失败时把媒体状态落为 failed，避免前端永远显示“处理中”。 */
async function markMediaFailed(job: Job, message: string): Promise<void> {
  const mediaId = mediaIdOf(job);
  if (!mediaId) return;
  await prisma.itemMedia
    .updateMany({ where: { id: mediaId, status: { not: 'ready' } }, data: { status: 'failed', lastError: message.slice(0, 500) } })
    .catch((err) => logger.warn({ err, jobId: job.id, mediaId }, '回写媒体失败状态出错'));
}

async function handleThumbnail(job: Job): Promise<Record<string, unknown>> {
  const mediaId = mediaIdOf(job);
  if (!mediaId) throw new Error('媒体任务缺少 mediaId');
  const media = await prisma.itemMedia.findUnique({ where: { id: mediaId } });
  if (!media || media.deletedAt) return { skipped: '媒体已删除' };
  // 重复执行不产生副作用：已经就绪就直接跳过，不再转码
  if (media.status === 'ready' && (media.kind !== 'image' || media.thumbKey)) return { skipped: '媒体已就绪' };
  try {
    if (media.kind === 'image') {
      const item = await prisma.item.findUnique({ where: { id: media.itemId } });
      if (!item) return { skipped: '条目已删除' };
      // 产物按 sha256 内容寻址，重复执行只是覆盖同一份文件，不产生重复文件
      const variants = await processImage(absPathOf(media.storageKey), item.familyId, media.sha256, putBuffer);
      await prisma.itemMedia.update({
        where: { id: mediaId },
        data: {
          status: 'ready',
          thumbKey: variants.thumbKey,
          largeKey: variants.largeKey,
          width: variants.width,
          height: variants.height,
          lastError: null,
        },
      });
      return { thumbKey: variants.thumbKey, width: variants.width, height: variants.height };
    }
    if (media.kind === 'document') {
      const info = await inspectDocument(absPathOf(media.storageKey));
      await prisma.itemMedia.update({
        where: { id: mediaId },
        data: { status: 'ready', lastError: null },
      });
      return { pageCount: info.pageCount };
    }
    await prisma.itemMedia.update({ where: { id: mediaId }, data: { status: 'ready', lastError: null } });
    return { skipped: '非图片/文档' };
  } catch (err) {
    // 任务还有自动重试机会时保持 processing，只记录最近一次错误；彻底失败由 runOnce 落 failed
    const message = err instanceof Error ? err.message.slice(0, 500) : '处理失败';
    await prisma.itemMedia.updateMany({ where: { id: mediaId, status: 'processing' }, data: { lastError: message } }).catch(() => undefined);
    throw err;
  }
}

function absPathOf(key: string): string {
  return absOf(key);
}

async function handleWaveform(job: Job): Promise<Record<string, unknown>> {
  const mediaId = mediaIdOf(job);
  if (!mediaId) throw new Error('音频任务缺少 mediaId');
  const media = await prisma.itemMedia.findUnique({ where: { id: mediaId } });
  if (!media || media.deletedAt) return { skipped: '媒体已删除' };
  if (media.status === 'ready' && (media.transcodeKey || media.waveformKey)) return { skipped: '媒体已就绪' };
  try {
    const item = await prisma.item.findUniqueOrThrow({ where: { id: media.itemId } });
    // 内容寻址 + 临时文件转存，重复执行不会留下重复产物
    const variants = await processAudio(
      absPathOf(media.storageKey),
      item.familyId,
      media.sha256,
      putBuffer,
      makeTmpPath,
    );
    await prisma.itemMedia.update({
      where: { id: mediaId },
      data: {
        status: 'ready',
        transcodeKey: variants.transcodeKey,
        waveformKey: variants.waveformKey,
        durationMs: variants.durationMs,
        lastError: null,
      },
    });
    return { transcodeKey: variants.transcodeKey, peaks: variants.peakCount, durationMs: variants.durationMs };
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 500) : '处理失败';
    await prisma.itemMedia.updateMany({ where: { id: mediaId, status: 'processing' }, data: { lastError: message } }).catch(() => undefined);
    throw err;
  }
}

async function handleExport(job: Job, ctx: JobContext): Promise<Record<string, unknown>> {
  const result = await buildExportZip(job, ctx.touchProgress);
  return { items: result.items, media: result.media, bytes: result.bytes, file: result.file };
}

/** 回收站保留期到期后彻底删除（含磁盘文件）。重复执行幂等：查不到的行/文件直接跳过。 */
async function handleTrashPurge(): Promise<Record<string, unknown>> {
  const cutoff = new Date(Date.now() - config.TRASH_RETENTION_DAYS * 86_400_000);
  const expired = await prisma.item.findMany({
    where: { status: 'trashed', deletedAt: { lt: cutoff } },
    include: { media: true },
    take: 500,
  });
  let removed = 0;
  for (const item of expired) {
    const keys = item.media.flatMap((m) => [m.storageKey, m.thumbKey, m.largeKey, m.transcodeKey, m.waveformKey]);
    await prisma.item.delete({ where: { id: item.id } });
    await Promise.all(keys.filter(Boolean).map((k) => remove(k!).catch(() => undefined)));
    removed += 1;
  }
  return { removed, cutoff: cutoff.toISOString() };
}

/** 清理孤儿文件与过期导出包，防止磁盘只涨不降。重复执行天然幂等。 */
async function handleStorageGc(): Promise<Record<string, unknown>> {
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const referenced = new Set<string>();
  const media = await prisma.itemMedia.findMany({ select: { storageKey: true, thumbKey: true, largeKey: true, transcodeKey: true, waveformKey: true } });
  for (const m of media) {
    for (const k of [m.storageKey, m.thumbKey, m.largeKey, m.transcodeKey, m.waveformKey]) if (k) referenced.add(k);
  }

  const root = config.STORAGE_ROOT;
  let scanned = 0;
  let deleted = 0;
  const cutoff = Date.now() - 24 * 3600 * 1000;

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'tmp') continue; // 临时目录单独处理
        await walk(full);
        continue;
      }
      scanned += 1;
      const key = path.relative(root, full).split(path.sep).join('/');
      if (referenced.has(key)) continue;
      const stat = await fsp.stat(full).catch(() => null);
      if (!stat || stat.mtimeMs > cutoff) continue;
      await fsp.rm(full, { force: true });
      deleted += 1;
    }
  }
  await walk(root);

  // 临时目录里超过 24 小时的残留（中断的上传/转码）直接清掉
  const tmp = path.join(root, 'tmp');
  for (const name of await fsp.readdir(tmp).catch(() => [])) {
    const full = path.join(tmp, name);
    const stat = await fsp.stat(full).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) {
      await fsp.rm(full, { force: true, recursive: true });
      deleted += 1;
    }
  }

  // 过期导出包，以及导出中断时遗留的 *.zip.tmp-<attempts> 临时文件
  const exportCutoff = Date.now() - config.EXPORT_RETENTION_DAYS * 86_400_000;
  for (const familyDir of await fsp.readdir(config.EXPORT_ROOT).catch(() => [])) {
    const dir = path.join(config.EXPORT_ROOT, familyDir);
    for (const file of await fsp.readdir(dir).catch(() => [])) {
      const full = path.join(dir, file);
      const stat = await fsp.stat(full).catch(() => null);
      if (!stat) continue;
      const staleTmp = file.includes('.zip.tmp-') && stat.mtimeMs < cutoff;
      const staleExport = file.endsWith('.zip') && stat.mtimeMs < exportCutoff;
      if (staleTmp || staleExport) {
        await fsp.rm(full, { force: true });
        deleted += 1;
      }
    }
  }

  return { scanned, deleted };
}

const HANDLERS: Record<string, Handler> = {
  media_thumbnail: handleThumbnail,
  media_waveform: handleWaveform,
  export_build: handleExport,
  trash_purge: handleTrashPurge,
  storage_gc: handleStorageGc,
};

/**
 * 原子领取一个任务：UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)。
 * locked_at 是 worker 心跳，执行期间定期刷新；
 * 进程崩溃后心跳停住，sweepStaleJobs 会把它回收回队列。
 */
async function claimJob(): Promise<Job | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE jobs SET status = 'running', started_at = now(), locked_at = now(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'queued' AND run_after <= now()
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `;
  const first = rows[0];
  if (!first) return null;
  return prisma.job.findUnique({ where: { id: first.id } });
}

/**
 * 回收中断任务：把卡死的 running 任务重新放回队列。
 *  - startup：worker 启动时所有 running 都来自上一个已死进程，无条件回收（重启自愈）
 *  - 周期巡检：只回收心跳超过 WORKER_STALE_MS 的任务（活着的 worker 会持续刷新心跳）
 * 回收时把 attempts 减回（该次执行随崩溃而消失），紧接着重新领取才不会重复计数。
 */
export async function sweepStaleJobs(mode: 'startup' | 'interval'): Promise<number> {
  const cutoff = new Date(Date.now() - config.WORKER_STALE_MS);
  const result =
    mode === 'startup'
      ? await prisma.$executeRaw`
          UPDATE jobs
          SET status = 'queued', run_after = now(), started_at = NULL, locked_at = NULL,
              finished_at = NULL, attempts = GREATEST(attempts - 1, 0), updated_at = now()
          WHERE status = 'running'
        `
      : await prisma.$executeRaw`
          UPDATE jobs
          SET status = 'queued', run_after = now(), started_at = NULL, locked_at = NULL,
              finished_at = NULL, attempts = GREATEST(attempts - 1, 0), updated_at = now()
          WHERE status = 'running' AND (locked_at IS NULL OR locked_at < ${cutoff})
        `;
  if (result > 0) logger.warn({ reclaimed: result, mode }, '回收中断后卡在 running 的任务，已重新入队');
  return result;
}

/** 每日维护任务去重入队：同类型仍有未结束任务时不重复创建，避免中断后堆积。 */
async function enqueueDailyOnce(type: 'trash_purge' | 'storage_gc'): Promise<void> {
  const exists = await prisma.job.findFirst({ where: { type, status: { in: ['queued', 'running'] } }, select: { id: true } });
  if (exists) {
    logger.info({ type, jobId: exists.id }, '维护任务已在队列中，跳过重覆入队');
    return;
  }
  await prisma.job.create({ data: { type, payload: {} as never } });
}

async function runOnce(): Promise<boolean> {
  const job = await claimJob();
  if (!job) return false;
  const handler = HANDLERS[job.type];
  // attempts 作为本次执行的“围栏代号”：任务被回收重跑后，旧执行的任何终态/进度回写都会失配
  const fence = { attempts: job.attempts };
  let heartbeat: NodeJS.Timeout | null = setInterval(() => {
    void prisma.job
      .updateMany({ where: { id: job.id, status: 'running', attempts: fence.attempts }, data: { lockedAt: new Date() } })
      .then((r) => {
        if (r.count === 0) logger.warn({ jobId: job.id }, '心跳回写失配：任务可能已被回收并重新领取');
      })
      .catch((err) => logger.warn({ err, jobId: job.id }, '心跳刷新失败'));
  }, config.WORKER_HEARTBEAT_MS);
  heartbeat.unref?.();
  const stopHeartbeat = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  };
  const touchProgress = async (progress: number) => {
    await prisma.job
      .updateMany({ where: { id: job.id, status: 'running', attempts: fence.attempts }, data: { progress } })
      .catch(() => undefined);
  };

  if (!handler) {
    await prisma.job.update({
      where: { id: job.id },
      data: { status: 'failed', finishedAt: new Date(), lastError: `未知任务类型 ${job.type}` },
    });
    stopHeartbeat();
    return true;
  }
  try {
    const result = await handler(job, { touchProgress });
    const written = await prisma.job.updateMany({
      where: { id: job.id, status: 'running', attempts: fence.attempts },
      data: { status: 'done', progress: 100, finishedAt: new Date(), result: result as never, lastError: null },
    });
    if (written.count === 0) {
      logger.warn({ jobId: job.id, type: job.type }, '任务完成回写失配（已被回收重跑），本次结果丢弃');
    } else {
      logger.info({ jobId: job.id, type: job.type, result }, '任务完成');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const exhausted = job.attempts >= job.maxAttempts;
    const backoffMs = computeBackoff(job.attempts);
    const written = await prisma.job.updateMany({
      where: { id: job.id, status: 'running', attempts: fence.attempts },
      data: {
        status: exhausted ? 'failed' : 'queued',
        lastError: message.slice(0, 1000),
        finishedAt: exhausted ? new Date() : null,
        runAfter: new Date(Date.now() + backoffMs),
        lockedAt: null,
      },
    });
    if (written.count === 0) {
      logger.warn({ jobId: job.id, type: job.type }, '任务失败回写失配（已被回收重跑），交由新执行重试');
    } else {
      logger.error({ jobId: job.id, type: job.type, attempts: job.attempts, err: message }, '任务失败');
      if (exhausted) await markMediaFailed(job, message);
    }
  }
  stopHeartbeat();
  return true;
}

export function computeBackoff(attempts: number): number {
  return Math.min(30 * 60_000, 60_000 * 5 ** Math.max(0, attempts - 1));
}

const DAILY = 24 * 3600 * 1000;
const REAPER_INTERVAL_MS = 30_000;

export function startWorker(): () => void {
  if (!config.WORKER_ENABLED) {
    logger.warn('WORKER_ENABLED=false，后台任务不会执行（缩略图/波形/导出将一直处于排队状态）');
    return () => undefined;
  }
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      let processed = 0;
      while (processed < 5 && (await runOnce())) processed += 1;
    } catch (err) {
      logger.error({ err }, 'worker 轮询失败');
    }
    if (!stopped) timer = setTimeout(tick, config.WORKER_POLL_MS);
  };

  // 重启即自愈：上次进程没跑完的 running 任务（缩略图/波形/导出）全部回收
  void sweepStaleJobs('startup')
    .catch((err) => logger.error({ err }, '启动时回收中断任务失败'))
    .finally(() => {
      if (!stopped) timer = setTimeout(tick, 1000);
    });

  // 进程被 kill -9 之外，也兜底巡检心跳过旧的任务（极端事件循环卡死等）
  const reaper = setInterval(() => {
    void sweepStaleJobs('interval').catch((err) => logger.error({ err }, '巡检中断任务失败'));
  }, REAPER_INTERVAL_MS);
  reaper.unref?.();

  // 每日维护任务：回收站清理 + 孤儿文件回收；同类型已有任务时去重，重复执行也幂等
  const daily = setInterval(() => {
    void enqueueDailyOnce('trash_purge')
      .then(() => enqueueDailyOnce('storage_gc'))
      .catch((err) => logger.error({ err }, '每日维护任务入队失败'));
  }, DAILY);
  daily.unref?.();

  logger.info({ pollMs: config.WORKER_POLL_MS, staleMs: config.WORKER_STALE_MS, heartbeatMs: config.WORKER_HEARTBEAT_MS }, '后台任务 worker 已启动');
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    clearInterval(reaper);
    clearInterval(daily);
  };
}

export const __test__ = { runOnce, computeBackoffForTest: computeBackoff };
