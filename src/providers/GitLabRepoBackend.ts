import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ProjectConfig } from '../core/config.js';
import type { RepoBackend } from '../interfaces/RepoBackend.js';
import type { MrStatus } from '../models/types.js';

/**
 * GitLab-backed implementation of RepoBackend.
 * Local git operations via execFileSync, remote operations via GitLab REST API.
 */
export class GitLabRepoBackend implements RepoBackend {
  private readonly gitlabUrl: string;
  private readonly projectId: string;
  private readonly token: string;
  private readonly apiBase: string;
  private readonly mergeBranch: string;

  constructor(config: ProjectConfig) {
    this.gitlabUrl = config.raw.GITLAB_URL || 'https://gitlab.com';
    this.projectId = config.GITLAB_PROJECT_ID;
    this.token = config.raw.GITLAB_TOKEN || '';
    this.apiBase = `${this.gitlabUrl}/api/v4/projects/${encodeURIComponent(this.projectId)}`;
    this.mergeBranch = config.GITLAB_MERGE_BRANCH;
  }

  // ---------------------------------------------------------------------------
  // Git helpers
  // ---------------------------------------------------------------------------

  private git(args: string[], cwd: string): string {
    try {
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch (err: unknown) {
      const e = err as { stderr?: string; status?: number };
      const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
      const code = e.status ?? 1;
      throw new Error(
        `git ${args.join(' ')} failed (exit ${code}) in ${cwd}: ${stderr}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // API helpers
  // ---------------------------------------------------------------------------

  private async apiGet<T>(path: string, query?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.apiBase}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        url.searchParams.set(k, v);
      }
    }
    const res = await fetch(url.toString(), {
      headers: { 'PRIVATE-TOKEN': this.token },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitLab GET ${path} returned ${res.status}: ${body}`);
    }
    return (await res.json()) as T;
  }

  private async apiPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method: 'POST',
      headers: {
        'PRIVATE-TOKEN': this.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitLab POST ${path} returned ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  }

  private async apiPut<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method: 'PUT',
      headers: {
        'PRIVATE-TOKEN': this.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitLab PUT ${path} returned ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  }

  // ---------------------------------------------------------------------------
  // Local git operations
  // ---------------------------------------------------------------------------

  async ensureCleanBase(repoDir: string, baseBranch: string): Promise<void> {
    this.git(['fetch', 'origin'], repoDir);
    this.git(['checkout', baseBranch], repoDir);
    this.git(['pull', 'origin', baseBranch], repoDir);
  }

  async ensureBranch(repoDir: string, branchName: string, baseBranch: string): Promise<void> {
    // Ensure we're on base branch first (avoid branch-in-use conflicts with worktrees)
    this.git(['fetch', 'origin'], repoDir);
    try {
      this.git(['checkout', baseBranch], repoDir);
    } catch {
      // May fail if baseBranch doesn't exist locally yet
      this.git(['checkout', '-b', baseBranch, `origin/${baseBranch}`], repoDir);
    }

    // Check if branch already exists locally or remotely
    try {
      this.git(['rev-parse', '--verify', branchName], repoDir);
      // Branch exists locally — nothing more to do (worktree will check it out)
    } catch {
      // Check remote
      try {
        this.git(['rev-parse', '--verify', `origin/${branchName}`], repoDir);
        // Exists on remote — create local tracking branch (don't checkout)
        this.git(['branch', branchName, `origin/${branchName}`], repoDir);
      } catch {
        // Does not exist anywhere — create from base (don't checkout)
        this.git(['branch', branchName, `origin/${baseBranch}`], repoDir);
      }
    }
  }

  async ensureWorktree(repoDir: string, branchName: string, worktreePath: string): Promise<void> {
    if (existsSync(worktreePath)) {
      return;
    }
    // Prune stale worktree references before adding new one
    try { this.git(['worktree', 'prune'], repoDir); } catch { /* non-fatal */ }
    this.git(['worktree', 'add', worktreePath, branchName], repoDir);
  }

  async commit(worktree: string, message: string): Promise<void> {
    this.git(['add', '-A'], worktree);
    // Check if there is anything to commit
    try {
      this.git(['diff', '--cached', '--quiet'], worktree);
      // No changes staged — nothing to commit
      return;
    } catch {
      // There are staged changes — proceed with commit
    }
    this.git(['commit', '-m', message], worktree);
  }

  async push(worktree: string, branch: string, force?: boolean): Promise<void> {
    const args = ['push', 'origin', branch];
    if (force) {
      args.splice(1, 0, '--force-with-lease');
    }
    this.git(args, worktree);
  }

  async rebase(worktree: string, baseBranch: string): Promise<{ success: boolean; conflictFiles?: string[] }> {
    this.git(['fetch', 'origin'], worktree);
    try {
      this.git(['rebase', `origin/${baseBranch}`], worktree);
      return { success: true };
    } catch {
      // Rebase failed — extract conflict files then abort
      let conflictFiles: string[] = [];
      try {
        const status = this.git(['diff', '--name-only', '--diff-filter=U'], worktree);
        conflictFiles = status.split('\n').filter(Boolean);
      } catch {
        // Could not list conflicts — return empty list
      }
      try {
        this.git(['rebase', '--abort'], worktree);
      } catch {
        // Abort may fail if rebase already cleaned up
      }
      return { success: false, conflictFiles };
    }
  }

  // ---------------------------------------------------------------------------
  // GitLab API operations
  // ---------------------------------------------------------------------------

  async createOrUpdateMr(
    branch: string,
    title: string,
    description: string,
  ): Promise<{ url: string; iid: number }> {
    // Check if an open MR already exists for this branch
    interface GitLabMr {
      iid: number;
      web_url: string;
      state: string;
    }

    const existing = await this.apiGet<GitLabMr[]>('/merge_requests', {
      source_branch: branch,
      target_branch: this.mergeBranch,
      state: 'opened',
    });

    if (existing.length > 0) {
      // Update existing MR
      const mr = existing[0];
      const updated = await this.apiPut<GitLabMr>(`/merge_requests/${mr.iid}`, {
        title,
        description,
      });
      return { url: updated.web_url, iid: updated.iid };
    }

    // Create new MR
    const created = await this.apiPost<GitLabMr>('/merge_requests', {
      source_branch: branch,
      target_branch: this.mergeBranch,
      title,
      description,
    });
    return { url: created.web_url, iid: created.iid };
  }

  async getMrStatus(branch: string): Promise<MrStatus> {
    interface GitLabMrDetail {
      iid: number;
      web_url: string;
      state: string;
      merge_status: string;
      head_pipeline: { status: string } | null;
    }

    const mrs = await this.apiGet<GitLabMrDetail[]>('/merge_requests', {
      source_branch: branch,
    });

    if (mrs.length === 0) {
      return {
        exists: false,
        state: 'not_found',
        ciStatus: 'unknown',
        mergeStatus: 'unknown',
        url: null,
        iid: null,
      };
    }

    const mr = mrs[0];

    return {
      exists: true,
      state: this.mapMrState(mr.state),
      ciStatus: this.mapCiStatus(mr.head_pipeline?.status ?? null),
      mergeStatus: this.mapMergeStatus(mr.merge_status),
      url: mr.web_url,
      iid: mr.iid,
    };
  }

  async mergeMr(iid: number): Promise<{ merged: boolean; error?: string }> {
    interface MergeResult {
      state: string;
      merge_error?: string;
    }

    try {
      const result = await this.apiPut<MergeResult>(`/merge_requests/${iid}/merge`, {});
      if (result.state === 'merged') {
        return { merged: true };
      }
      return { merged: false, error: result.merge_error || `Unexpected state: ${result.state}` };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { merged: false, error: message };
    }
  }

  async detectMerged(branch: string): Promise<boolean> {
    interface GitLabMrBasic {
      state: string;
    }

    const mrs = await this.apiGet<GitLabMrBasic[]>('/merge_requests', {
      source_branch: branch,
      state: 'merged',
    });

    return mrs.length > 0;
  }

  // ---------------------------------------------------------------------------
  // Worktree cleanup
  // ---------------------------------------------------------------------------

  async removeWorktree(repoDir: string, worktreePath: string, branch?: string): Promise<void> {
    // Step 1: Remove the worktree directory
    if (existsSync(worktreePath)) {
      try {
        this.git(['worktree', 'remove', '--force', worktreePath], repoDir);
      } catch {
        // Fallback: manual directory removal + prune
        const { rmSync } = await import('node:fs');
        rmSync(worktreePath, { recursive: true, force: true });
        try { this.git(['worktree', 'prune'], repoDir); } catch { /* non-fatal */ }
      }
    } else {
      // Path already gone — just prune stale references
      try { this.git(['worktree', 'prune'], repoDir); } catch { /* non-fatal */ }
    }

    // Step 2: Delete local branch (only if already merged)
    if (branch) {
      try {
        this.git(['branch', '-d', branch], repoDir);
      } catch {
        // Branch may not exist locally or not fully merged — skip
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Status mapping helpers (doc 12 §13.4)
  // ---------------------------------------------------------------------------

  private mapMrState(state: string): MrStatus['state'] {
    switch (state) {
      case 'opened': return 'opened';
      case 'merged': return 'merged';
      case 'closed': return 'closed';
      default: return 'not_found';
    }
  }

  private mapCiStatus(status: string | null): MrStatus['ciStatus'] {
    switch (status) {
      case 'success': return 'success';
      case 'failed': return 'failed';
      case 'running': return 'running';
      case 'pending': return 'pending';
      case 'created': return 'created';
      default: return 'unknown';
    }
  }

  private mapMergeStatus(status: string): MrStatus['mergeStatus'] {
    switch (status) {
      case 'can_be_merged': return 'can_be_merged';
      case 'cannot_be_merged': return 'cannot_be_merged';
      case 'checking': return 'checking';
      default: return 'unknown';
    }
  }
}
