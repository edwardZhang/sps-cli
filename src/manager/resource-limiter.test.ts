import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResourceLimiter } from './resource-limiter.js';

describe('ResourceLimiter', () => {
  describe('tryAcquire / release', () => {
    it('acquires when under limit', () => {
      const limiter = new ResourceLimiter({ maxGlobalWorkers: 2 });
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
    });

    it('rejects when at capacity', () => {
      const limiter = new ResourceLimiter({ maxGlobalWorkers: 1 });
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(false);
    });

    it('allows acquire after release', () => {
      const limiter = new ResourceLimiter({ maxGlobalWorkers: 1 });
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(false);
      limiter.release();
      expect(limiter.tryAcquire()).toBe(true);
    });

    it('release does not go below zero', () => {
      const limiter = new ResourceLimiter({ maxGlobalWorkers: 2 });
      limiter.release(); // Already at 0
      limiter.release(); // Still at 0
      // Should still allow max acquires
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(false);
    });
  });

  describe('tryAcquireDetailed', () => {
    it('returns structured result with stats', () => {
      const limiter = new ResourceLimiter({ maxGlobalWorkers: 2 });
      const result = limiter.tryAcquireDetailed();
      expect(result.acquired).toBe(true);
      expect(result.stats.active).toBe(1);
      expect(result.stats.max).toBe(2);
      expect(result.stats.canLaunch).toBe(true);
    });

    it('returns blockReason when at capacity', () => {
      const limiter = new ResourceLimiter({ maxGlobalWorkers: 1 });
      limiter.tryAcquire();
      const result = limiter.tryAcquireDetailed();
      expect(result.acquired).toBe(false);
      expect(result.stats.blockReason).toBe('workers');
    });
  });

  describe('getStats', () => {
    it('reports correct active count', () => {
      const limiter = new ResourceLimiter({ maxGlobalWorkers: 5 });
      limiter.tryAcquire();
      limiter.tryAcquire();
      const stats = limiter.getStats();
      expect(stats.active).toBe(2);
      expect(stats.max).toBe(5);
    });
  });

  describe('setActiveCount', () => {
    it('overrides internal active count for recovery', () => {
      const limiter = new ResourceLimiter({ maxGlobalWorkers: 3 });
      limiter.setActiveCount(2);
      expect(limiter.getStats().active).toBe(2);
      expect(limiter.tryAcquire()).toBe(true);
      expect(limiter.tryAcquire()).toBe(false); // Now at 3
    });
  });

  describe('enforceStagger', () => {
    it('resolves immediately on first call', async () => {
      const limiter = new ResourceLimiter({ staggerDelayMs: 100 });
      const start = Date.now();
      await limiter.enforceStagger();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(50);
    });

    it('delays subsequent calls within stagger window', async () => {
      const limiter = new ResourceLimiter({ staggerDelayMs: 100 });
      await limiter.enforceStagger();
      const start = Date.now();
      await limiter.enforceStagger();
      const elapsed = Date.now() - start;
      // Should have waited ~100ms
      expect(elapsed).toBeGreaterThanOrEqual(50);
    });
  });

  describe('formatBlockReason', () => {
    it('formats worker cap message', () => {
      const limiter = new ResourceLimiter({ maxGlobalWorkers: 1 });
      limiter.tryAcquire();
      const stats = limiter.getStats();
      const msg = limiter.formatBlockReason(stats);
      expect(msg).toContain('worker cap reached');
      expect(msg).toContain('1/1');
    });

    it('formats available message when not blocked', () => {
      const limiter = new ResourceLimiter({ maxGlobalWorkers: 5 });
      const stats = limiter.getStats();
      const msg = limiter.formatBlockReason(stats);
      expect(msg).toContain('resources available');
    });
  });
});
