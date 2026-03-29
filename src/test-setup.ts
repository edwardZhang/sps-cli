/**
 * Vitest global setup — suppress stderr log noise during tests.
 *
 * Production modules write [worker-manager], [supervisor], [completion-judge]
 * logs to stderr. This silences them in test output.
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
