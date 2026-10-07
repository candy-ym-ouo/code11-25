import { Router } from 'express';
import fs from 'node:fs';
import { asyncHandler } from '../http/asyncHandler';
import { clientMeta, currentUser } from '../middleware/auth';
import { familyCtx, requireFamily } from '../middleware/family';
import { writeLimiter } from '../middleware/rateLimit';
import * as exportService from '../services/exportService';
import * as audit from '../services/auditService';
import { notFound } from '../http/errors';

export const exportsRouter = Router({ mergeParams: true });

exportsRouter.post(
  '/',
  requireFamily('family:export'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const job = await exportService.createExportJob(user.id, ctx, clientMeta(req));
    res.status(202).json(job);
  }),
);

exportsRouter.get(
  '/:jobId',
  requireFamily('family:export'),
  asyncHandler(async (req, res) => {
    const ctx = familyCtx(req);
    res.json({ job: await exportService.getExportJob(ctx.familyId, req.params.jobId!) });
  }),
);

exportsRouter.post(
  '/:jobId/retry',
  requireFamily('family:export'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const job = await exportService.retryExportJob(user.id, ctx.familyId, req.params.jobId!, clientMeta(req));
    res.status(202).json(job);
  }),
);

exportsRouter.get(
  '/:jobId/download',
  requireFamily('family:export'),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const job = await exportService.getExportJob(ctx.familyId, req.params.jobId!);
    if (job.status !== 'done') throw notFound('导出包尚未生成完成');
    const file = exportService.exportZipPath(ctx.familyId, job.jobId);
    if (!fs.existsSync(file)) throw notFound('导出包已被清理，请重新导出');
    await audit.record({
      familyId: ctx.familyId,
      actorId: user.id,
      action: 'export.download',
      targetType: 'job',
      targetId: job.jobId,
      ...clientMeta(req),
    });
    res.download(file, `heirloom-export-${job.jobId}.zip`);
  }),
);

