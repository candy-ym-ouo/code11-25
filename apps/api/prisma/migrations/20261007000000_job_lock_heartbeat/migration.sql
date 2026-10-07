-- 进程崩溃 / kill -9 后 running 任务会永久卡住。
-- 增加 worker 心跳列：领取任务时置位、执行期间定期刷新，
-- 心跳过旧的 running 任务由 worker 启动时与定时巡检自动回收为 queued。
ALTER TABLE "jobs" ADD COLUMN "locked_at" TIMESTAMP(3);

-- 历史遗留的 running 任务（本字段为 NULL）在迁移后第一次启动 worker 时统一回收
CREATE INDEX "jobs_status_locked_at_idx" ON "jobs" ("status", "locked_at");
