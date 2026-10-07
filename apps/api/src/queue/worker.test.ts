import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job, ItemMedia } from '@prisma/client';

/**
 * worker 崩溃恢复语义测试。
 * 不依赖真实数据库：用内存表模拟 jobs / item_media，
 * SQL（领取、回收）按语句内容分派到等价的内存实现。
 */

const db = vi.hoisted(() => {
  const jobs = new Map<string, any>();
  const media = new Map<string, any>();
  let seq = 0;
  return {
    jobs,
    media,
    reset() {
      jobs.clear();
      media.clear();
      seq = 0;
    },
    nextId: () => `job-${++seq}`,
  };
});

vi.mock('../db', () => ({
  prisma: {
    job: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => db.jobs.get(where.id) ?? null),
      findFirst: vi.fn(
        async ({ where }: { where: { type?: string; status?: { in?: string[] } } }) =>
          [...db.jobs.values()].find(
            (j) =>
              (!where.type || j.type === where.type) && (!where.status?.in || where.status.in.includes(j.status)),
          ) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Partial<Job> & { payload: unknown } }) => {
        const now = new Date();
        const row = {
          id: db.nextId(),
          familyId: null,
          maxAttempts: 3,
          attempts: 0,
          progress: 0,
          result: undefined,
          lastError: null,
          ...data,
          runAfter: data.runAfter ?? now,
          startedAt: data.startedAt ?? null,
          finishedAt: data.finishedAt ?? null,
          lockedAt: data.lockedAt ?? null,
          createdAt: data.createdAt ?? now,
          updatedAt: now,
        };
        db.jobs.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = db.jobs.get(where.id);
        if (!row) throw Object.assign(new Error('not found'), { code: 'P2025' });
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const row of db.jobs.values()) {
          if (
            row.id === where.id &&
            (where.status === undefined || row.status === where.status) &&
            (where.attempts === undefined || row.attempts === where.attempts)
          ) {
            Object.assign(row, data, { updatedAt: new Date() });
            count += 1;
          }
        }
        return { count };
      }),
    },
    itemMedia: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => db.media.get(where.id) ?? null),
      findMany: vi.fn(async () => [...db.media.values()]),
      update: vi.fn(async ({ where, data }: any) => {
        const row = db.media.get(where.id);
        if (!row) throw Object.assign(new Error('not found'), { code: 'P2025' });
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const row2 of db.media.values()) {
          const statusMatch =
            where.status === undefined
              ? true
              : typeof where.status === 'string'
                ? row2.status === where.status
                : where.status.not !== undefined
                  ? row2.status !== where.status.not
                  : true;
          if (row2.id === where.id && statusMatch) {
            Object.assign(row2, data);
            count += 1;
          }
        }
        return { count };
      }),
    },
    item: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        familyId: 'fam-1',
      })),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        familyId: 'fam-1',
      })),
      findMany: vi.fn(async () => []),
      delete: vi.fn(async () => ({})),
      aggregate: vi.fn(async () => ({ _max: { sortOrder: null } })),
    },
    family: {
      findUniqueOrThrow: vi.fn(async () => ({ id: 'fam-1', name: '家' })),
      count: vi.fn(async () => 0),
    },
    $queryRaw: vi.fn(async (fragments: TemplateStringsArray) => {
      const sql = fragments.join('');
      // claimJob
      if (sql.includes("UPDATE jobs SET status = 'running'")) {
        const queued = [...db.jobs.values()]
          .filter((j) => j.status === 'queued' && j.runAfter.getTime() <= Date.now())
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
        if (!queued) return [];
        queued.status = 'running';
        queued.startedAt = new Date();
        queued.lockedAt = new Date();
        queued.attempts += 1;
        return [{ id: queued.id }];
      }
      throw new Error(`未模拟的 $queryRaw: ${sql.slice(0, 60)}`);
    }),
    $executeRaw: vi.fn(async (fragments: TemplateStringsArray, ...values: unknown[]) => {
      const sql = fragments.join('?');
      const startup = sql.includes("WHERE status = 'running'") && !sql.includes('locked_at IS NULL');
      const rows = [...db.jobs.values()].filter((j) => {
        if (j.status !== 'running') return false;
        if (startup) return true;
        const cutoff = values[0] as Date;
        return j.lockedAt === null || j.lockedAt < cutoff;
      });
      for (const j of rows) {
        j.status = 'queued';
        j.runAfter = new Date();
        j.startedAt = null;
        j.lockedAt = null;
        j.finishedAt = null;
        j.attempts = Math.max(j.attempts - 1, 0);
      }
      return rows.length;
    }),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaShim)),
  },
}));

const prismaShim = db;

vi.mock('../logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../media/image', () => ({
  processImage: vi.fn(async () => ({
    largeKey: 'derived/sha-lg.webp',
    thumbKey: 'derived/sha-thumb.webp',
    width: 100,
    height: 100,
  })),
}));
vi.mock('../media/audio', () => ({
  processAudio: vi.fn(async () => ({
    transcodeKey: 'derived/sha.mp3',
    waveformKey: 'derived/sha.waveform.json',
    durationMs: 1000,
    peakCount: 900,
  })),
}));
vi.mock('../media/document', () => ({ inspectDocument: vi.fn(async () => ({ thumbKey: null, pageCount: 1 })) }));
vi.mock('../storage/local', () => ({
  putBuffer: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
  absOf: (key: string) => `/tmp/storage/${key}`,
}));
vi.mock('../services/mediaService', () => ({
  makeTmpPath: (ext: string) => `/tmp/storage/tmp/proc-${ext}`,
}));

const exportState = vi.hoisted(() => ({ failBefore: 0, calls: 0, seenAttempts: [] as number[] }));
vi.mock('../services/exportService', () => ({
  buildExportZip: vi.fn(async (job: Job, onProgress?: (p: number) => Promise<void>) => {
    exportState.calls += 1;
    exportState.seenAttempts.push(job.attempts);
    await onProgress?.(42);
    if (exportState.calls <= exportState.failBefore) throw new Error('磁盘满了');
    return { file: `/tmp/x/${job.id}.zip`, items: 1, media: 2, bytes: 99 };
  }),
}));

import { __test__, sweepStaleJobs } from './worker';

function makeMedia(over: Partial<ItemMedia> = {}) {
  const row = {
    id: 'media-1',
    itemId: 'item-1',
    kind: 'image',
    status: 'processing',
    storageKey: 'families/fam-1/objects/ab/sha.jpg',
    sha256: 'sha',
    mimeType: 'image/jpeg',
    byteSize: BigInt(10),
    width: null,
    height: null,
    durationMs: null,
    thumbKey: null,
    largeKey: null,
    transcodeKey: null,
    waveformKey: null,
    originalName: 'a.jpg',
    caption: null,
    transcript: null,
    sortOrder: 0,
    lastError: null,
    createdBy: 'u1',
    createdAt: new Date(),
    deletedAt: null,
    ...over,
  };
  db.media.set(row.id, row);
  return row;
}

async function enqueueJob(over: Partial<Job> = {}) {
  const now = new Date();
  return (await (await import('../db')).prisma.job.create({
    data: {
      type: 'media_thumbnail',
      payload: {},
      status: 'queued',
      runAfter: now,
      ...over,
    } as never,
  })) as Job;
}

beforeEach(() => {
  db.reset();
  exportState.failBefore = 0;
  exportState.calls = 0;
  exportState.seenAttempts = [];
});

describe('任务领取与完成', () => {
  it('媒体任务成功后：job=done 且媒体 ready，重复执行自动跳过', async () => {
    makeMedia();
    const job = await enqueueJob({ type: 'media_thumbnail', payload: { mediaId: 'media-1' } });

    expect(await __test__.runOnce()).toBe(true);
    let row = db.jobs.get(job.id)!;
    expect(row.status).toBe('done');
    expect(row.progress).toBe(100);
    expect(row.lockedAt).not.toBeNull();
    expect(db.media.get('media-1').status).toBe('ready');

    // 队列已空
    expect(await __test__.runOnce()).toBe(false);

    // 手动再丢一个同样的任务（重复执行）：媒体已就绪，直接跳过，不会再次转码落库
    await enqueueJob({ type: 'media_thumbnail', payload: { mediaId: 'media-1' } });
    expect(await __test__.runOnce()).toBe(true);
    expect(db.media.get('media-1').thumbKey).toBe('derived/sha-thumb.webp');
  });

  it('失败按指数退避重新排队，attempts 不累加崩溃的那一次；用尽次数才 failed 且媒体落 failed', async () => {
    const mediaMod = await import('../media/image');
    vi.mocked(mediaMod.processImage).mockRejectedValueOnce(new Error('sharp 炸了'));
    makeMedia();
    const job = await enqueueJob({ payload: { mediaId: 'media-1' } });

    await __test__.runOnce();
    let row = db.jobs.get(job.id)!;
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(1);
    expect(row.lockedAt).toBeNull();
    expect(row.runAfter.getTime()).toBeGreaterThan(Date.now());
    // 还有重试机会：媒体保持 processing，但能看到最近错误
    expect(db.media.get('media-1').status).toBe('processing');
    expect(db.media.get('media-1').lastError).toContain('sharp');

    // 退避结束后继续失败两次（attempts 2、3），用尽 maxAttempts
    row.runAfter = new Date(0);
    vi.mocked(mediaMod.processImage).mockRejectedValue(new Error('一直炸'));
    await __test__.runOnce();
    row = db.jobs.get(job.id)!;
    expect(row.attempts).toBe(2);
    expect(row.status).toBe('queued');
    row.runAfter = new Date(0);
    await __test__.runOnce();
    row = db.jobs.get(job.id)!;
    expect(row.attempts).toBe(3);
    expect(row.status).toBe('failed');
    expect(row.finishedAt).not.toBeNull();
    expect(db.media.get('media-1').status).toBe('failed');
    vi.mocked(mediaMod.processImage).mockReset();
    vi.mocked(mediaMod.processImage).mockResolvedValue({
      largeKey: 'derived/sha-lg.webp',
      thumbKey: 'derived/sha-thumb.webp',
      width: 100,
      height: 100,
    });
  });

  it('导出任务执行期间进度回写生效', async () => {
    const job = await enqueueJob({ type: 'export_build', familyId: 'fam-1' });
    await __test__.runOnce();
    const row = db.jobs.get(job.id)!;
    expect(row.status).toBe('done');
    expect(row.result).toMatchObject({ items: 1, bytes: 99 });
  });

  it('媒体已删除时任务直接跳过为 done，不报错', async () => {
    const job = await enqueueJob({ payload: { mediaId: 'gone' } });
    await __test__.runOnce();
    expect(db.jobs.get(job.id)!.status).toBe('done');
    expect(db.jobs.get(job.id)!.result).toEqual({ skipped: '媒体已删除' });
  });
});

describe('进程中断恢复', () => {
  it('启动时把所有 running 任务回收为 queued，紧接着就能被重新执行', async () => {
    makeMedia({ status: 'processing', thumbKey: null });
    const stale = await enqueueJob({
      status: 'running',
      attempts: 1,
      startedAt: new Date(Date.now() - 600_000),
      lockedAt: new Date(Date.now() - 600_000),
      payload: { mediaId: 'media-1' },
    });

    const reclaimed = await sweepStaleJobs('startup');
    expect(reclaimed).toBe(1);
    const row = db.jobs.get(stale.id)!;
    expect(row.status).toBe('queued');
    expect(row.lockedAt).toBeNull();
    expect(row.startedAt).toBeNull();
    expect(row.attempts).toBe(0); // 崩溃的那次不计入重试次数

    expect(await __test__.runOnce()).toBe(true);
    expect(db.jobs.get(stale.id)!.status).toBe('done');
    expect(db.media.get('media-1').status).toBe('ready');
  });

  it('周期巡检只回收心跳过旧的 running 任务，心跳新鲜的不动', async () => {
    const oldJob = await enqueueJob({
      status: 'running',
      attempts: 2,
      lockedAt: new Date(Date.now() - 300_000),
    });
    const freshJob = await enqueueJob({
      status: 'running',
      attempts: 1,
      lockedAt: new Date(),
    });

    const reclaimed = await sweepStaleJobs('interval');
    expect(reclaimed).toBe(1);
    expect(db.jobs.get(oldJob.id)!.status).toBe('queued');
    expect(db.jobs.get(oldJob.id)!.attempts).toBe(1);
    expect(db.jobs.get(freshJob.id)!.status).toBe('running');
  });

  it('围栏：旧执行在任务被回收重跑后才结束，其 done/failed 回写不会覆盖新执行', async () => {
    exportState.failBefore = 1;
    const job = await enqueueJob({ type: 'export_build', familyId: 'fam-1' });

    // 第一次执行失败并退避
    await __test__.runOnce();
    let row = db.jobs.get(job.id)!;
    expect(row.status).toBe('queued');
    expect(exportState.seenAttempts).toEqual([1]);

    // 模拟另一种场景：任务 running 中被 sweep 回收（崩溃），随后重跑成功
    row.status = 'running';
    row.attempts = 1;
    row.lockedAt = new Date(Date.now() - 300_000);
    exportState.failBefore = 0;
    await sweepStaleJobs('interval'); // -> queued, attempts 0
    await __test__.runOnce(); // 领取后 attempts=1，成功
    row = db.jobs.get(job.id)!;
    expect(row.status).toBe('done');
    expect(exportState.seenAttempts).toEqual([1, 1]); // 崩溃的那次不计入，重跑仍是第 1 次
  });
});
