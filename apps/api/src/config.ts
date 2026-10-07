import fs from 'node:fs';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

/** 从当前文件向上找 pnpm-workspace.yaml，得到仓库根目录（dev / dist / 容器内都适用）。 */
function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

export const REPO_ROOT = findRepoRoot(__dirname);

// 优先加载仓库根目录的 .env；如果外部已经注入环境变量（systemd 的 EnvironmentFile 等），这一步会自动跳过。
loadEnv({ path: path.join(REPO_ROOT, '.env') });

const boolish = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_NAME: z.string().default('家中物品来历册'),
  APP_URL: z.string().default('http://localhost:4000'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().min(1, '必须提供 DATABASE_URL'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET 至少 32 位，请用 openssl rand -hex 32 生成'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL: z.string().default('14d'),
  COOKIE_SECURE: boolish(false),

  STORAGE_ROOT: z.string().default('./data/uploads'),
  EXPORT_ROOT: z.string().default('./data/exports'),
  BACKUP_ROOT: z.string().default('./data/backups'),
  MAX_IMAGE_MB: z.coerce.number().int().positive().default(25),
  MAX_AUDIO_MB: z.coerce.number().int().positive().default(200),
  MAX_DOC_MB: z.coerce.number().int().positive().default(50),
  /** 音频转码/波形依赖宿主机 ffmpeg；不在 PATH 里时可以用这两个变量指定绝对路径 */
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),

  WORKER_ENABLED: boolish(true),
  WORKER_POLL_MS: z.coerce.number().int().min(200).default(2000),
  /** running 任务心跳超过该毫秒数即判定为进程中断（必须 > WORKER_HEARTBEAT_MS） */
  WORKER_STALE_MS: z.coerce.number().int().min(30_000).default(120_000),
  /** 执行长任务期间心跳刷新间隔 */
  WORKER_HEARTBEAT_MS: z.coerce.number().int().min(5_000).default(15_000),
  TRASH_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  EXPORT_RETENTION_DAYS: z.coerce.number().int().min(1).default(7),

  PUBLIC_SIGNUP: boolish(false),
  SERVE_WEB: boolish(true),
  WEB_DIST: z.string().default('./apps/web/dist'),
  TZ: z.string().default('Asia/Shanghai'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // 启动即失败，避免带着错误配置运行
  console.error(`[config] 环境变量校验失败：\n${issues}\n\n请参考 .env.example 补全后重试。`);
  process.exit(1);
}

const env = parsed.data;

const abs = (p: string) => (path.isAbsolute(p) ? p : path.join(REPO_ROOT, p));

export const config = {
  ...env,
  COOKIE_SECURE: env.COOKIE_SECURE,
  STORAGE_ROOT: abs(env.STORAGE_ROOT),
  EXPORT_ROOT: abs(env.EXPORT_ROOT),
  BACKUP_ROOT: abs(env.BACKUP_ROOT),
  WEB_DIST: abs(env.WEB_DIST),
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  /** 单文件上限（字节）。用反向代理时，代理层的请求体上限要 ≥ 这里的值 */
  limits: {
    image: env.MAX_IMAGE_MB * 1024 * 1024,
    audio: env.MAX_AUDIO_MB * 1024 * 1024,
    document: env.MAX_DOC_MB * 1024 * 1024,
  },
};

export type AppConfig = typeof config;
