/**
 * ResourceLimiter — global worker resource control.
 *
 * Shared across all project runners in the tick process.
 * Controls total worker count, launch stagger, and memory usage.
 */
import { freemem, totalmem } from 'node:os';

export interface ResourceConfig {
  /** Maximum concurrent workers globally (default 30) */
  maxGlobalWorkers: number;
  /** Minimum delay between consecutive launches in ms (default 5000) */
  staggerDelayMs: number;
  /** Maximum system memory usage percent before pausing launches (default 80) */
  maxMemoryPercent: number;
}

export interface ResourceStats {
  active: number;
  max: number;
  memoryPercent: number;
  canLaunch: boolean;
}

const DEFAULT_CONFIG: ResourceConfig = {
  maxGlobalWorkers: 30,
  staggerDelayMs: 5_000,
  maxMemoryPercent: 80,
};

export class ResourceLimiter {
  private readonly config: ResourceConfig;
  private activeCount = 0;
  private lastLaunchAt = 0;

  constructor(config?: Partial<ResourceConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Try to acquire a worker slot.
   * Returns true if launch is allowed, false if at capacity.
   */
  tryAcquire(): boolean {
    if (this.activeCount >= this.config.maxGlobalWorkers) {
      return false;
    }
    if (this.memoryPercent() > this.config.maxMemoryPercent) {
      return false;
    }
    this.activeCount++;
    return true;
  }

  /**
   * Release a worker slot (call when worker exits).
   */
  release(): void {
    if (this.activeCount > 0) {
      this.activeCount--;
    }
  }

  /**
   * Enforce stagger delay between launches.
   * Returns a promise that resolves when the delay has passed.
   */
  async enforceStagger(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastLaunchAt;
    if (elapsed < this.config.staggerDelayMs) {
      const wait = this.config.staggerDelayMs - elapsed;
      await new Promise(r => setTimeout(r, wait));
    }
    this.lastLaunchAt = Date.now();
  }

  /**
   * Get current resource stats.
   */
  getStats(): ResourceStats {
    const mem = this.memoryPercent();
    return {
      active: this.activeCount,
      max: this.config.maxGlobalWorkers,
      memoryPercent: Math.round(mem),
      canLaunch: this.activeCount < this.config.maxGlobalWorkers && mem <= this.config.maxMemoryPercent,
    };
  }

  /**
   * Override active count (used during Recovery to sync with actual state).
   */
  setActiveCount(count: number): void {
    this.activeCount = count;
  }

  private memoryPercent(): number {
    const total = totalmem();
    const free = freemem();
    return ((total - free) / total) * 100;
  }
}
