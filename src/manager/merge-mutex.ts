/**
 * MergeMutex — per-project async mutex for serializing merge operations.
 *
 * Uses a Promise-based queue so only one merge executes at a time
 * within a tick process. Non-blocking: callers `await acquire()`,
 * perform their merge, then `release()`.
 *
 * This ensures parallel workers can code simultaneously, but their
 * merges into the target branch happen one at a time — preventing
 * merge conflicts caused by concurrent pushes to the same branch.
 */
export class MergeMutex {
  private queue: (() => void)[] = [];
  private locked = false;

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>(resolve => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next(); // Wake up next waiter
    } else {
      this.locked = false;
    }
  }

  get isLocked(): boolean {
    return this.locked;
  }

  get pendingCount(): number {
    return this.queue.length;
  }
}
