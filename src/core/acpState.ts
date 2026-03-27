import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ACPState } from '../models/acp.js';

function defaultState(): ACPState {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: 'init',
    sessions: {},
  };
}

export function readACPState(stateFile: string): ACPState {
  if (!existsSync(stateFile)) return defaultState();
  try {
    const raw = readFileSync(stateFile, 'utf-8');
    const parsed = JSON.parse(raw) as ACPState;
    return {
      version: parsed.version ?? 1,
      updatedAt: parsed.updatedAt || new Date().toISOString(),
      updatedBy: parsed.updatedBy || 'migrate',
      sessions: parsed.sessions || {},
    };
  } catch {
    return defaultState();
  }
}

export function writeACPState(stateFile: string, state: ACPState, updatedBy: string): void {
  const dir = dirname(stateFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  state.updatedAt = new Date().toISOString();
  state.updatedBy = updatedBy;

  const tmpFile = stateFile + '.tmp';
  writeFileSync(tmpFile, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmpFile, stateFile);
}
