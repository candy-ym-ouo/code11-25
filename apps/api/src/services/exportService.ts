import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';
import { CATEGORY_LABELS, ITEM_STATUS_LABELS, VISIBILITY_LABELS, formatAcquired, htmlToText } from '@heirloom/shared';
import type { Job } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { logger } from '../logger';
import { notFound } from '../http/errors';
import { absOf } from '../storage/local';
import { slugify } from '../utils/crypto';
import * as audit from './auditService';
import type { FamilyContext } from './permissionService';

export interface ActorMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export async function createExportJob(userId: string, ctx: FamilyContext, meta: ActorMeta) {
  // 幂等去重：已有排队/执行中的导出任务时直接复用，重复点击「开始导出」不产生第二个 ZIP。
  // 已失败的任务不在这里复用（失败是终态，重试应当显式发起一次新任务）。
  const existing = await prisma.job.findFirst({
    where: { familyId: ctx.familyId, type: 'export_build', status: { in: ['queued', 'running'] } },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) {
    return { jobId: existing.id, status: existing.status, deduplicated: true };
  }

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
  return { jobId: job.id, status: job.status, deduplicated: false };
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

function exportPartPath(familyId: string, jobId: string): string {
  return path.join(config.EXPORT_ROOT, familyId, `${jobId}.zip.part-${process.pid}`);
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
 * 幂等性：先写 <jobId>.zip.part-<pid> 临时文件，成功后原子 rename；
 * 任务被中断后重试只会留下一个待 GC 的临时包，永远不会覆盖/损坏已有的完成包。
 * 同一任务重复执行产出的内容等价（以 jobId 为产物名）。
 */
export async function buildExportZip(
  job: Job,
  onProgress?: (progress: number) => Promise<void> | void,
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
  const partPath = exportPartPath(familyId, job.id);
  await fsp.mkdir(path.dirname(outPath), { recursive: true });

  const output = fs.createWriteStream(partPath);
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
  } catch (err) {
    // 主动 abort 避免句柄泄漏；临时包立刻删掉，不把失败重试的垃圾留给磁盘
    archive.abort();
    await fsp.rm(partPath, { force: true }).catch(() => undefined);
    throw err;
  }

  // 整个 ZIP 完整落盘后再原子换名：下载方永远拿不到半截压缩包，重试也不会覆盖已完成的包
  try {
    await fsp.rename(partPath, outPath);
  } catch (err) {
    // 极端情况下 part 与目标跨设备（配置变更过 EXPORT_ROOT 挂载点），退化为复制后删除
    await fsp.copyFile(partPath, outPath).catch(() => {
      throw err;
    });
    await fsp.rm(partPath, { force: true }).catch(() => undefined);
  }

  const stat = await fsp.stat(outPath);
  logger.info({ jobId: job.id, items: items.length, media: mediaTotal, bytes: stat.size }, '导出包生成完成');
  return { file: outPath, items: items.length, media: mediaTotal, bytes: stat.size };
}

