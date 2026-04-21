/**
 * @module        console-server/watchers/pipelinePoller
 * @description   轮询每个项目的 supervisor.pid，状态变化推 pipeline.status
 *                用 2s 间隔；chokidar 对 pid 变化不敏感，所以用 setInterval
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eventBus } from '../sse/eventBus.js';

interface PollState {
  pid: number | null;
  status: 'idle' | 'running';
}

function pipelineState(projectDir: string): PollState {
  const pidFile = resolve(projectDir, 'runtime', 'supervisor.pid');
  if (!existsSync(pidFile)) return { pid: null, status: 'idle' };
  try {
    const pid = Number.parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) return { pid: null, status: 'idle' };
    try {
      process.kill(pid, 0);
      return { pid, status: 'running' };
    } catch {
      return { pid: null, status: 'idle' };
    }
  } catch {
    return { pid: null, status: 'idle' };
  }
}

export function startPipelinePoller(coralRoot: string, intervalMs = 2000): () => void {
  const projectsDir = resolve(coralRoot, 'projects');
  const previous = new Map<string, PollState>();

  const tick = (): void => {
    if (!existsSync(projectsDir)) return;
    const projects = readdirSync(projectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const name of projects) {
      const state = pipelineState(resolve(projectsDir, name));
      const prev = previous.get(name);
      if (!prev || prev.status !== state.status || prev.pid !== state.pid) {
        eventBus.publish('pipeline.status', { project: name, ...state });
        previous.set(name, state);
      }
    }
  };

  const id = setInterval(tick, intervalMs);
  // 启动时跑一次，让 UI 得到初始值
  tick();

  return () => clearInterval(id);
}
