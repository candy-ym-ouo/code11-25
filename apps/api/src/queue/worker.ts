import type { Job } from '@prisma/client';
import type { Dirent } from 'node:fs';
import { config } from '../config';
import { prisma } from '../db';
import { logger } from '../logger';
import { processImage } from '../media/image';
import { processAudio } from '../media/audio';
import { inspectDocument } from '../media/document';
import { putBuffer, remove } from '../storage/local';
import { makeTmpPath } from '../services/mediaService';
import { buildExportZip } from '../services/exportService';

export interface JobContext {
  /**
   * 任务执行期间的心跳 / 进度上报。更新 progress 会顺带刷新 jobs.updated_at，
   * worker 据此区分「还在跑的长任务」与「进程被 kill 后卡死的僵尸任务」。
   */
  heartbeat: (progress?: number) => Promise<void>;
}

type Handler = (job: Job, ctx: JobContext) => Promise<Record<string, unknown>>;

function describeError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message.slice(0, 500) : fallback;
}

async function handleThumbnail(job: Job): Promise<Record<string, unknown>> {
  const { mediaId } = job.payload as { mediaId: string };
  const media = await prisma.itemMedia.findUnique({ where: { id: mediaId } });
  if (!media) return { skipped: '媒体已删除' };
  try {
    if (media.kind === 'image') {
      const item = await prisma.item.findUnique({ where: { id: media.itemId } });
      if (!item) return { skipped: '条目已删除' };
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
    await prisma.itemMedia.update({ where: { id: mediaId }, data: { status: 'ready' } });
    return { skipped: '非图片/文档' };
  } catch (err) {
    // 产物 key 由 sha256 内容寻址，重试只是覆盖写同一份字节，不产生副作用
    await prisma.itemMedia.update({
      where: { id: mediaId },
      data: { status: 'failed', lastError: describeError(err, '处理失败') },
    }).catch(() => undefined);
    throw err;
  }
}

function absPathOf(key: string): string {
  // 延迟引入，避免循环依赖
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { absOf } = require('../storage/local') as typeof import('../storage/local');
  return absOf(key);
}

async function handleWaveform(job: Job): Promise<Record<string, unknown>> {
  const { mediaId } = job.payload as { mediaId: string };
  const media = await prisma.itemMedia.findUnique({ where: { id: mediaId } });
  if (!media) return { skipped: '媒体已删除' };
  try {
    const item = await prisma.item.findUnique({ where: { id: media.itemId } });
    if (!item) return { skipped: '条目已删除' };
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
    // 之前异常会直接冒泡：job 靠重试兜底，但媒体永远停在 processing，前端一直转圈。这里显式落 failed。
    await prisma.itemMedia.update({
      where: { id: mediaId },
      data: { status: 'failed', lastError: describeError(err, '音频处理失败') },
    }).catch(() => undefined);
    throw err;
  }
}

async function handleExport(job: Job, ctx: JobContext): Promise<Record<string, unknown>> {
  const result = await buildExportZip(job, (progress) => ctx.heartbeat(progress));
  return { items: result.items, media: result.media, bytes: result.bytes, file: result.file };
}

/** 回收站保留期到期后彻底删除（含磁盘文件）。 */
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

/** 清理孤儿文件与过期导出包，防止磁盘只涨不降。 */
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

  // 临时目录里超过 24 小时的残留（中断的上传 / 中断的媒体转码）直接清掉
  const tmp = path.join(root, 'tmp');
  for (const name of await fsp.readdir(tmp).catch(() => [])) {
    const full = path.join(tmp, name);
    const stat = await fsp.stat(full).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) {
      await fsp.rm(full, { force: true, recursive: true });
      deleted += 1;
    }
  }

  // 过期导出包，以及崩溃时没来得及 rename / 删除的 .part 临时包
  const exportCutoff = Date.now() - config.EXPORT_RETENTION_DAYS * 86_400_000;
  for (const familyDir of await fsp.readdir(config.EXPORT_ROOT).catch(() => [])) {
    const dir = path.join(config.EXPORT_ROOT, familyDir);
    for (const file of await fsp.readdir(dir).catch(() => [])) {
      const full = path.join(dir, file);
      const stat = await fsp.stat(full).catch(() => null);
      if (!stat) continue;
      const stalePart = file.endsWith('.part') || file.includes('.part-');
      if ((stalePart && stat.mtimeMs < cutoff) || (!stalePart && stat.mtimeMs < exportCutoff)) {
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

/** 当前进程正在执行的任务（单进程同时只跑一个），供心跳使用。 */
let activeJobId: string | null = null;

/**
 * 判定一个 running 任务的心跳是否已超时（进程已死/僵死）。
 * 纯函数，便于单测：staleMs 内有心跳 → 存活；否则需要重新入队。
 */
export function isHeartbeatStale(lastUpdatedAt: Date, now: Date, staleMs: number): boolean {
  return now.getTime() - lastUpdatedAt.getTime() > staleMs;
}

/**
 * 自愈：进程被 kill -9 / OOM / 断电后，任务会永远停在 status='running'，
 * 缩略图与导出也随之卡死。所有「执行中但心跳超时」的任务一律重新入队。
 * 多实例部署时只认心跳：还在正常上报的任务不会被别的实例误抢。
 * 返回重新入队的任务数。
 *
 * 注意时区：updated_at/run_after 都是 timestamp without time zone（Prisma 存 UTC 墙钟），
 * 必须和 `now() AT TIME ZONE 'UTC'` 比较；直接和 timestamptz 的 now() 比较会在
 * Asia/Shanghai 下产生 8 小时隐式偏移，导致所有正常任务都被误判成僵尸。
 */
export async function reapStaleJobs(): Promise<number> {
  const requeued = await prisma.$executeRaw`
    UPDATE jobs
    SET status = 'queued', run_after = now() AT TIME ZONE 'UTC', started_at = NULL
    WHERE status = 'running'
      AND updated_at < (now() AT TIME ZONE 'UTC') - (${config.WORKER_STALE_MS} * interval '1 millisecond')
  `;
  return requeued;
}

/** 原子领取一个任务：UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)。 */
async function claimJob(): Promise<Job | null> {
  // run_after 是 timestamp without time zone（UTC 墙钟），必须与 now() AT TIME ZONE 'UTC' 比较，
  // 否则在非 UTC 时区（如 Asia/Shanghai）会发生 8 小时隐式偏移，退避后的任务永远领不出来
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE jobs
    SET status = 'running',
        started_at = now() AT TIME ZONE 'UTC',
        updated_at = now() AT TIME ZONE 'UTC',
        attempts = attempts + 1,
        progress = 0
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'queued' AND run_after <= now() AT TIME ZONE 'UTC'
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

async function runOnce(): Promise<boolean> {
  const job = await claimJob();
  if (!job) return false;
  const handler = HANDLERS[job.type];
  if (!handler) {
    await prisma.job.update({
      where: { id: job.id },
      data: { status: 'failed', finishedAt: new Date(), lastError: `未知任务类型 ${job.type}` },
    });
    return true;
  }
  activeJobId = job.id;
  const heartbeat: JobContext['heartbeat'] = async (progress) => {
    try {
      await prisma.job.update({
        where: { id: job.id },
        data: progress === undefined ? { updatedAt: new Date() } : { progress: Math.max(0, Math.min(100, progress)), updatedAt: new Date() },
      });
    } catch {
      // 心跳失败不应打断任务本身（例如恰好正在重启数据库）
    }
  };
  try {
    const result = await handler(job, { heartbeat });
    // 只在任务仍是本次 attempt 的 running 状态时写终态：
    // 若本进程长时间卡住、任务已被僵尸巡检重新分配并跑完，迟到的结果不能覆盖新状态
    const done = await prisma.job.updateMany({
      where: { id: job.id, status: 'running' },
      data: { status: 'done', progress: 100, finishedAt: new Date(), result: result as never, lastError: null },
    });
    if (done.count > 0) logger.info({ jobId: job.id, type: job.type, result }, '任务完成');
    else logger.warn({ jobId: job.id, type: job.type }, '任务执行完但已被重新分配，丢弃迟到结果');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const exhausted = job.attempts >= job.maxAttempts;
    const backoffMs = Math.min(30 * 60_000, 60_000 * 5 ** Math.max(0, job.attempts - 1));
    const failed = await prisma.job.updateMany({
      where: { id: job.id, status: 'running' },
      data: {
        status: exhausted ? 'failed' : 'queued',
        lastError: message.slice(0, 1000),
        finishedAt: exhausted ? new Date() : null,
        runAfter: new Date(Date.now() + backoffMs),
      },
    });
    if (failed.count > 0) {
      logger.error({ jobId: job.id, type: job.type, attempts: job.attempts, err: message }, '任务失败');
    } else {
      logger.warn({ jobId: job.id, type: job.type }, '任务失败但已被重新分配，丢弃迟到的失败状态');
    }
  } finally {
    activeJobId = null;
  }
  return true;
}

const DAILY = 24 * 3600 * 1000;

export function startWorker(): () => void {
  if (!config.WORKER_ENABLED) {
    logger.warn('WORKER_ENABLED=false，后台任务不会执行（缩略图/波形/导出将一直处于排队状态）');
    return () => undefined;
  }
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (stopped) return; // 优雅关闭期间不再领新任务，避免刚领就被强杀又制造僵尸
    try {
      let processed = 0;
      while (!stopped && processed < 5 && (await runOnce())) processed += 1;
    } catch (err) {
      logger.error({ err }, 'worker 轮询失败');
    }
    if (!stopped) timer = setTimeout(tick, config.WORKER_POLL_MS);
  };

  // 心跳 + 僵尸任务巡检：先自愈上次进程中断遗留的 running 任务，再开始轮询
  const reap = async () => {
    try {
      const count = await reapStaleJobs();
      if (count > 0) logger.warn({ count }, '检测到中断遗留的执行中任务，已重新入队等待重试');
    } catch (err) {
      logger.error({ err }, '僵尸任务巡检失败');
    }
  };

  const monitor = setInterval(() => {
    // 正在跑的长任务定期续命；即便没有进度更新也不会被误判为僵尸
    if (activeJobId) {
      void prisma.job
        .update({ where: { id: activeJobId }, data: { updatedAt: new Date() } })
        .catch(() => undefined);
    }
    void reap();
  }, config.WORKER_HEARTBEAT_MS);

  void reap().finally(() => {
    if (!stopped) timer = setTimeout(tick, 1000);
  });

  // 每日维护任务：回收站清理 + 孤儿文件回收；两个处理器本身都是幂等的，重复入队无副作用
  const daily = setInterval(() => {
    void prisma.job
      .create({ data: { type: 'trash_purge', payload: {} as never } })
      .then(() => prisma.job.create({ data: { type: 'storage_gc', payload: {} as never } }))
      .catch((err) => logger.error({ err }, '每日维护任务入队失败'));
  }, DAILY);

  logger.info(
    { pollMs: config.WORKER_POLL_MS, staleMs: config.WORKER_STALE_MS, heartbeatMs: config.WORKER_HEARTBEAT_MS },
    '后台任务 worker 已启动',
  );
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    clearInterval(monitor);
    clearInterval(daily);
  };
}

export const __test__ = { runOnce, computeBackoffForTest: (attempts: number) => Math.min(30 * 60_000, 60_000 * 5 ** Math.max(0, attempts - 1)) };
