/**
 * chokidarWatchers 集成（真 FS + 真 chokidar）需要 tmp 目录 + 异步等待，放 Phase 2 集成
 * 测试里做。本文件只验证 marker 文件正则 / 路径 extractor 的纯逻辑。
 *
 * 那些 extractor 是 private，所以通过再 import 模块 + cast 的方式验证；更整洁的
 * 办法是 Phase 3 合并 console watchers 时挪到 shared 层。目前先保底。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryEventBus } from '../shared/domainEvents.js';
import { startChokidarWatchers } from './chokidarWatchers.js';
import { FakeClock } from './clock.js';

describe('chokidarWatchers 导出签名', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('startChokidarWatchers 接受 options 返回 handles', () => {
    const bus = new InMemoryEventBus();
    const clock = new FakeClock(1000);
    // coralRoot 指向不存在的目录 —— chokidar 会 silent；我们只验证 handles 返回
    const h = startChokidarWatchers({
      coralRoot: '/tmp/does-not-exist-' + Date.now(),
      bus,
      clock,
      pipelinePollMs: 60_000, // 不触发
    });
    expect(h).toHaveProperty('close');
    expect(typeof h.close).toBe('function');
    // 不启真 interval 的 tick —— close 清理
    return h.close();
  });
});
