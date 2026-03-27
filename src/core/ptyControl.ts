import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProjectContext } from './context.js';

export type PTYControlCommand =
  | {
      id: string;
      type: 'respond';
      slot: string;
      response: string;
      createdAt: string;
      source: string;
    }
  | {
      id: string;
      type: 'confirm';
      slot: string;
      createdAt: string;
      source: string;
    }
  | {
      id: string;
      type: 'reject';
      slot: string;
      createdAt: string;
      source: string;
    };

function queueFile(ctx: ProjectContext): string {
  return resolve(ctx.paths.runtimeDir, 'pty-control.ndjson');
}

function normalizeSlot(slot: string): string {
  return slot.startsWith('worker-') ? slot : `worker-${slot}`;
}

export function enqueuePTYControl(
  ctx: ProjectContext,
  command: Omit<PTYControlCommand, 'id' | 'createdAt' | 'slot'> & { slot: string },
): PTYControlCommand {
  mkdirSync(ctx.paths.runtimeDir, { recursive: true });
  const record: PTYControlCommand = {
    ...command,
    slot: normalizeSlot(command.slot),
    id: `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
  } as PTYControlCommand;
  appendFileSync(queueFile(ctx), `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

export function enqueuePTYResponse(
  ctx: ProjectContext,
  slot: string,
  response: string,
  source: string,
): PTYControlCommand {
  return enqueuePTYControl(ctx, {
    type: 'respond',
    slot,
    response,
    source,
  } as PTYControlCommand & { slot: string });
}

export function drainPTYControl(ctx: ProjectContext): PTYControlCommand[] {
  const file = queueFile(ctx);
  if (!existsSync(file)) return [];

  const processingFile = `${file}.${process.pid}.${Date.now()}.processing`;
  try {
    renameSync(file, processingFile);
  } catch {
    return [];
  }

  try {
    const raw = readFileSync(processingFile, 'utf8');
    const commands = raw
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line) as PTYControlCommand)
      .map(command => ({ ...command, slot: normalizeSlot(command.slot) }));
    return commands;
  } finally {
    rmSync(processingFile, { force: true });
  }
}
