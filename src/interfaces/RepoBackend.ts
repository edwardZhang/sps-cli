/**
 * @module        RepoBackend
 * @description   代码仓库后端接口，抽象分支管理、MR 操作及 Worktree 生命周期
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-19
 * @updated       2026-03-24
 *
 * @role          interface
 * @layer         interface
 * @boundedContext repository-operations
 */

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
  removeWorktree(repoDir: string, worktreePath: string, branch?: string): Promise<void>;
}
