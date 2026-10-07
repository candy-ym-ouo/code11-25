import { Router } from 'express';
import { updateMediaSchema } from '@heirloom/shared';
import { asyncHandler } from '../http/asyncHandler';
import { clientMeta, currentUser } from '../middleware/auth';
import { familyCtx, requireFamily } from '../middleware/family';
import { writeLimiter } from '../middleware/rateLimit';
import { validateBody } from '../middleware/validation';
import * as mediaService from '../services/mediaService';
import { sendStoredFile } from '../http/sendFile';

export const mediaRouter = Router({ mergeParams: true });

mediaRouter.get(
  '/:mediaId/raw',
  requireFamily('family:read'),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const media = await mediaService.loadMediaForUser(user.id, ctx, req.params.mediaId!);
    const target = await mediaService.mediaFileTarget(media, 'raw');
    sendStoredFile(req, res, {
      key: target.key,
      size: target.size,
      mimeType: target.mimeType,
      filename: media.originalName,
    });
  }),
);

mediaRouter.get(
  '/:mediaId/download',
  requireFamily('family:read'),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const media = await mediaService.loadMediaForUser(user.id, ctx, req.params.mediaId!);
    const target = await mediaService.mediaFileTarget(media, 'download');
    sendStoredFile(req, res, {
      key: target.key,
      size: target.size,
      mimeType: target.mimeType,
      filename: media.originalName,
      download: true,
    });
  }),
);

mediaRouter.get(
  '/:mediaId/thumb',
  requireFamily('family:read'),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const media = await mediaService.loadMediaForUser(user.id, ctx, req.params.mediaId!);
    const target = await mediaService.mediaFileTarget(media, 'thumb');
    sendStoredFile(req, res, {
      key: target.key,
      size: target.size,
      mimeType: target.mimeType,
      filename: `${media.id}-thumb.webp`,
    });
  }),
);

mediaRouter.get(
  '/:mediaId/waveform',
  requireFamily('family:read'),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const media = await mediaService.loadMediaForUser(user.id, ctx, req.params.mediaId!);
    const target = await mediaService.mediaFileTarget(media, 'waveform');
    res.setHeader('Content-Type', 'application/json');
    sendStoredFile(req, res, {
      key: target.key,
      size: target.size,
      mimeType: 'application/json',
      filename: `${media.id}.waveform.json`,
    });
  }),
);

mediaRouter.post(
  '/:mediaId/reprocess',
  requireFamily('family:read'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const result = await mediaService.reprocessMedia(user.id, ctx, req.params.mediaId!, clientMeta(req));
    res.status(202).json(result);
  }),
);

mediaRouter.patch(
  '/:mediaId',
  requireFamily('family:read'),
  writeLimiter,
  validateBody(updateMediaSchema),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    const media = await mediaService.updateMedia(user.id, ctx, req.params.mediaId!, req.body, clientMeta(req));
    res.json({ media });
  }),
);

mediaRouter.delete(
  '/:mediaId',
  requireFamily('family:read'),
  writeLimiter,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const ctx = familyCtx(req);
    await mediaService.softDeleteMedia(user.id, ctx, req.params.mediaId!, clientMeta(req));
    res.status(204).end();
  }),
);

