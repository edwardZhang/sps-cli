/**
 * @module        test-setup
 * @description   Vitest 全局配置，抑制测试中的 stderr 日志噪音
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-29
 * @updated       2026-03-29
 *
 * @role          test-setup
 * @layer         entry
 * @boundedContext test
 */
import { vi } from 'vitest';

const originalWrite = process.stderr.write.bind(process.stderr);

vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any, ...rest: any[]) => {
  const msg = typeof chunk === 'string' ? chunk : '';
  // Suppress known log prefixes from production code
  if (/^\[(worker-manager|supervisor|completion-judge|integration-queue)\]/.test(msg)) {
    return true;
  }
  // Pass through everything else (test framework output, actual errors)
  return (originalWrite as any)(chunk, ...rest);
});
