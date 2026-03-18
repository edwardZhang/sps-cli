import type { MrStatus } from '../models/types.js';

export interface RepoBackend {
  ensureCleanBase(repoDir: string, baseBranch: string): Promise<void>;
  ensureBranch(repoDir: string, branchName: string, baseBranch: string): Promise<void>;
  ensureWorktree(repoDir: string, branchName: string, worktreePath: string): Promise<void>;
  commit(worktree: string, message: string): Promise<void>;
  push(worktree: string, branch: string, force?: boolean): Promise<void>;
  createOrUpdateMr(branch: string, title: string, description: string): Promise<{ url: string; iid: number }>;
  getMrStatus(branch: string): Promise<MrStatus>;
  mergeMr(iid: number): Promise<{ merged: boolean; error?: string }>;
  detectMerged(branch: string): Promise<boolean>;
  rebase(worktree: string, baseBranch: string): Promise<{ success: boolean; conflictFiles?: string[] }>;
}
