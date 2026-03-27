import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';

export function tmux(args: string[]): string | null {
  try {
    return execFileSync('tmux', args, {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    if (stderr.includes('server exited unexpectedly') || stderr.includes('no server running')) {
      try {
        const uid = process.getuid?.() ?? 1000;
        rmSync(`/tmp/tmux-${uid}`, { recursive: true, force: true });
        return execFileSync('tmux', args, {
          encoding: 'utf-8',
          timeout: 10_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function sessionExists(session: string): boolean {
  return tmux(['has-session', '-t', session]) !== null;
}

export function capturePaneText(session: string, lines: number): string {
  return tmux(['capture-pane', '-t', session, '-p', '-S', `-${lines}`]) ?? '';
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pastePrompt(session: string, prompt: string): Promise<void> {
  const bufferFile = `/tmp/sps-acp-${Date.now()}.txt`;
  writeFileSync(bufferFile, prompt);
  tmux(['load-buffer', bufferFile]);
  tmux(['paste-buffer', '-t', session]);
  try { rmSync(bufferFile, { force: true }); } catch { /* noop */ }
  await sleep(1_500);
  tmux(['send-keys', '-t', session, 'Enter']);
}
