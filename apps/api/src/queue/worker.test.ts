import { describe, expect, it } from 'vitest';
import { isHeartbeatStale, __test__ } from './worker';

describe('僵尸任务判定 isHeartbeatStale', () => {
  const now = new Date('2026-10-07T08:00:00.000Z');
  const staleMs = 10 * 60_000;

  it('心跳在阈值内 → 存活（长任务不应被误杀）', () => {
    expect(isHeartbeatStale(new Date('2026-10-07T07:59:00.000Z'), now, staleMs)).toBe(false);
    expect(isHeartbeatStale(now, now, staleMs)).toBe(false);
  });

  it('心跳超过阈值 → 僵尸，需要重新入队', () => {
    expect(isHeartbeatStale(new Date('2026-10-07T07:49:59.000Z'), now, staleMs)).toBe(true);
    expect(isHeartbeatStale(new Date('2026-10-07T07:00:00.000Z'), now, staleMs)).toBe(true);
  });

  it('恰好等于阈值不算僵尸（边界：必须严格大于），给时钟抖动留余量', () => {
    expect(isHeartbeatStale(new Date(now.getTime() - staleMs), now, staleMs)).toBe(false);
  });
});

describe('失败重试退避 computeBackoffForTest', () => {
  it('首次失败退避 1 分钟，随后按 5 倍指数增长，上限 30 分钟', () => {
    expect(__test__.computeBackoffForTest(1)).toBe(60_000);
    expect(__test__.computeBackoffForTest(2)).toBe(5 * 60_000);
    expect(__test__.computeBackoffForTest(3)).toBe(25 * 60_000);
    expect(__test__.computeBackoffForTest(4)).toBe(30 * 60_000);
    expect(__test__.computeBackoffForTest(10)).toBe(30 * 60_000);
  });

  it('异常入参不会产生负退避', () => {
    expect(__test__.computeBackoffForTest(0)).toBe(60_000);
  });
});
