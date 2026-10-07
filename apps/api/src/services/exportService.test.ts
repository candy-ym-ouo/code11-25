import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '@prisma/client';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = {
  storage: '',
  exports: '',
};

vi.mock('../config', () => ({
  config: {
    get STORAGE_ROOT() {
      return tmpRoot.storage;
    },
    get EXPORT_ROOT() {
      return tmpRoot.exports;
    },
    TRASH_RETENTION_DAYS: 30,
    EXPORT_RETENTION_DAYS: 7,
  },
}));

const db = vi.hoisted(() => ({
  family: { findUniqueOrThrow: vi.fn() },
  item: { findMany: vi.fn() },
  job: { update: vi.fn(async () => ({})) },
}));
vi.mock('../db', () => ({ prisma: db }));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { buildExportZip, exportZipPath } from './exportService';

function baseJob(over: Partial<Job> = {}): Job {
  return {
    id: 'job-export-1',
    familyId: 'fam-1',
    type: 'export_build',
    payload: {},
    status: 'running',
    attempts: 1,
    maxAttempts: 3,
    progress: 0,
    result: undefined,
    lastError: null,
    runAfter: new Date(),
    startedAt: null,
    finishedAt: null,
    lockedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as unknown as Job;
}

describe('buildExportZip 中断安全', () => {
  beforeEach(async () => {
    tmpRoot.storage = await fsp.mkdtemp(path.join(os.tmpdir(), 'heirloom-storage-'));
    tmpRoot.exports = await fsp.mkdtemp(path.join(os.tmpdir(), 'heirloom-exports-'));
    db.family.findUniqueOrThrow.mockResolvedValue({ id: 'fam-1', name: '我家' });
    db.item.findMany.mockResolvedValue([]);
  });

  afterEach(async () => {
    await fsp.rm(tmpRoot.storage, { recursive: true, force: true });
    await fsp.rm(tmpRoot.exports, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('成功时只留下最终 zip，临时文件被 rename 掉，进度回调带围栏数据', async () => {
    db.item.findMany.mockResolvedValue([
      {
        id: 'item-1',
        title: '旧柜子',
        category: 'furniture',
        acquiredAt: null,
        acquiredPrecision: 'unknown',
        acquiredLabel: null,
        acquiredNote: null,
        placeProvince: null,
        placeCity: null,
        placeText: null,
        storageLocation: null,
        condition: null,
        visibility: 'family',
        storyHtml: null,
        sortAt: new Date(),
        creator: { displayName: '小明' },
        people: [],
        media: [],
      },
    ]);
    const progress: number[] = [];
    const result = await buildExportZip(baseJob(), async (p) => {
      progress.push(p);
    });

    const finalPath = exportZipPath('fam-1', 'job-export-1');
    expect(fs.existsSync(finalPath)).toBe(true);
    expect(result.file).toBe(finalPath);
    expect(progress).toContain(90);

    const dir = await fsp.readdir(path.dirname(finalPath));
    expect(dir.filter((n) => n.includes('.tmp-'))).toHaveLength(0);
  });

  it('每次执行使用带 attempts 的独立临时文件，重跑不覆盖另一次中断的残留', async () => {
    // 模拟第一次执行（attempts=1）中断后留下的半成品
    const finalPath = exportZipPath('fam-1', 'job-export-1');
    await fsp.mkdir(path.dirname(finalPath), { recursive: true });
    const leftover = `${finalPath}.tmp-1`;
    await fsp.writeFile(leftover, '半成品');

    const result = await buildExportZip(baseJob({ attempts: 2 }));
    expect(fs.existsSync(result.file)).toBe(true);

    // buildExportZip 开头会清掉同任务更早的 tmp 残留
    const dir = await fsp.readdir(path.dirname(finalPath));
    expect(dir).toContain('job-export-1.zip');
    expect(dir.some((n) => n.endsWith('.tmp-1'))).toBe(false);
    expect(dir.some((n) => n.endsWith('.tmp-2'))).toBe(false);
  });

  it('生成过程中抛错时：最终 zip 不存在、临时文件被清掉，错误继续上抛', async () => {
    db.item.findMany.mockRejectedValueOnce(new Error('数据库连接断开'));
    const finalPath = exportZipPath('fam-1', 'job-export-1');

    await expect(buildExportZip(baseJob())).rejects.toThrow('数据库连接断开');
    expect(fs.existsSync(finalPath)).toBe(false);
    const dir = await fsp.readdir(path.dirname(finalPath)).catch(() => []);
    expect(dir.some((n) => n.includes('.tmp-'))).toBe(false);
  });
});
