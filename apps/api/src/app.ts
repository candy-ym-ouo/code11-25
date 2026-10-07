import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { randomUUID } from 'node:crypto';
import { config } from './config';
import { logger } from './logger';
import { attachUser } from './middleware/auth';
import { csrfGuard } from './middleware/csrf';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { authRouter } from './routes/auth';
import { familiesRouter } from './routes/families';
import { itemsRouter } from './routes/items';
import { mediaRouter } from './routes/media';
import { peopleRouter } from './routes/people';
import { shareLinksRouter } from './routes/shareLinks';
import { exportsRouter } from './routes/exports';
import { invitesRouter } from './routes/invites';
import { publicRouter } from './routes/public';
import { prisma } from './db';
import { exists, ensureDirs, writeJson } from './storage/local';
import { hasFfmpeg } from './media/audio';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    const id = req.header('x-request-id') ?? randomUUID();
    req.requestId = id;
    res.setHeader('X-Request-Id', id);
    next();
  });

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId,
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
      // 只记录排查需要的字段，避免把整个 header（含 Cookie）灌进日志
      serializers: {
        req: (req: express.Request) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res: express.Response) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  app.use(
    helmet({
      // 前端由本进程托管（或由反向代理托管）；CSP 交给部署层按需下发
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(
    cors({
      origin: config.isProd ? [config.APP_URL] : true,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieParser());

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', app: config.APP_NAME, env: config.NODE_ENV });
  });

  app.get('/readyz', async (_req, res) => {
    const checks: Record<string, string> = {};
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.db = 'ok';
    } catch {
      checks.db = 'fail';
    }
    try {
      await ensureDirs();
      const probe = `${config.STORAGE_ROOT}/.probe.json`;
      await writeJson('.probe.json', { at: new Date().toISOString() });
      checks.storage = (await exists('.probe.json')) ? 'ok' : 'fail';
      void probe;
    } catch {
      checks.storage = 'fail';
    }
    try {
      // 存在心跳过旧的 running 任务，说明 worker 已中断（正常会被自动回收）
      const staleRunning = await prisma.job.findFirst({
        where: { status: 'running', lockedAt: { lt: new Date(Date.now() - config.WORKER_STALE_MS) } },
        select: { id: true },
      });
      checks.worker = config.WORKER_ENABLED ? (staleRunning ? 'stalled' : 'ok') : 'disabled';
    } catch {
      checks.worker = 'fail';
    }
    const healthy = checks.db === 'ok' && checks.storage === 'ok' && checks.worker !== 'fail';
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', checks });
  });

  app.get('/api/v1/system/info', async (req, res, next) => {
    try {
      if (!req.user || req.user.systemRole !== 'sysadmin') {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: '仅系统管理员可查看' } });
        return;
      }
      const [users, families, items, jobs] = await Promise.all([
        prisma.user.count(),
        prisma.family.count({ where: { deletedAt: null } }),
        prisma.item.count({ where: { status: { not: 'trashed' } } }),
        prisma.job.groupBy({ by: ['status'], _count: true }),
      ]);
      res.json({
        version: process.env.npm_package_version ?? '1.0.0',
        node: process.version,
        env: config.NODE_ENV,
        ffmpeg: (await hasFfmpeg()) ? 'available' : 'missing',
        counts: { users, families, items },
        jobs: jobs.map((j) => ({ status: j.status, count: j._count })),
      });
    } catch (err) {
      next(err);
    }
  });

  app.use('/api/v1/auth', csrfGuard, attachUser, authRouter);
  app.use('/api/v1/families', csrfGuard, attachUser, familiesRouter);
  app.use('/api/v1/families/:fid/items', csrfGuard, attachUser, itemsRouter);
  app.use('/api/v1/families/:fid/people', csrfGuard, attachUser, peopleRouter);
  app.use('/api/v1/families/:fid/media', csrfGuard, attachUser, mediaRouter);
  app.use('/api/v1/families/:fid/share-links', csrfGuard, attachUser, shareLinksRouter);
  app.use('/api/v1/families/:fid/exports', csrfGuard, attachUser, exportsRouter);
  app.use('/api/v1/invites', csrfGuard, attachUser, invitesRouter);
  app.use('/api/v1/public', csrfGuard, attachUser, publicRouter);

  /**
   * 前端静态资源：pnpm build 之后，API 可以直接把 apps/web/dist 托管出去，
   * 单进程就是一个完整应用，不需要额外的前置服务器。
   * 开发时用 Vite dev server（5173）即可，这里检测不到产物会自动跳过。
   */
  const indexHtml = path.join(config.WEB_DIST, 'index.html');
  if (config.SERVE_WEB && fs.existsSync(indexHtml)) {
    app.use(
      express.static(config.WEB_DIST, {
        index: false,
        setHeaders: (res, filePath) => {
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
          } else {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      }),
    );
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path === '/healthz' || req.path === '/readyz') return next();
      res.sendFile(indexHtml, { headers: { 'Cache-Control': 'no-cache' } });
    });
    logger.info({ webDist: config.WEB_DIST }, '已托管前端构建产物');
  } else if (config.SERVE_WEB) {
    logger.warn(
      { webDist: config.WEB_DIST },
      '未找到前端构建产物（先执行 pnpm build），当前只提供 API',
    );
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
