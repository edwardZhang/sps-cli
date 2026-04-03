/**
 * @module        queue
 * @description   流水线任务队列的原子读写与删除
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-19
 * @updated       2026-04-03
 *
 * @role          util
 * @layer         core
 * @boundedContext pipeline
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Read pipeline_order.json — a pure array of seq numbers.
 * Returns empty array if file doesn't exist.
 */
export function readQueue(filePath: string): number[] {
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is number => typeof v === 'number');
  } catch {
    return [];
  }
}

/**
 * Atomic write of pipeline_order.json.
 */
export function writeQueue(filePath: string, queue: number[]): void {
  const tmpFile = filePath + '.tmp';
  writeFileSync(tmpFile, JSON.stringify(queue, null, 2) + '\n');
  renameSync(tmpFile, filePath);
}

/**
 * Remove a seq from the queue and write back atomically.
 */
export function removeFromQueue(filePath: string, seq: number): void {
  const queue = readQueue(filePath);
  const updated = queue.filter((s) => s !== seq);
  if (updated.length !== queue.length) {
    writeQueue(filePath, updated);
  }
}
