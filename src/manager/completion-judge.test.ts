import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { CompletionJudge, type JudgeInput } from './completion-judge.js';

// ─── Helpers ──────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sps-judge-test-'));
}

/** Create a minimal git repo with a branch for testing */
function initGitRepo(dir: string, baseBranch = 'main'): void {
  execFileSync('git', ['init', '-b', baseBranch, dir], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@test.com'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test'], { stdio: 'pipe' });
  writeFileSync(join(dir, 'README.md'), '# Test\n');
  execFileSync('git', ['-C', dir, 'add', '.'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'commit', '-m', 'init'], { stdio: 'pipe' });
}

function createBranch(dir: string, branch: string): void {
  execFileSync('git', ['-C', dir, 'checkout', '-b', branch], { stdio: 'pipe' });
}

function addCommit(dir: string, filename: string, content: string, message: string): void {
  writeFileSync(join(dir, filename), content);
  execFileSync('git', ['-C', dir, 'add', filename], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'commit', '-m', message], { stdio: 'pipe' });
}

function checkoutBranch(dir: string, branch: string): void {
  execFileSync('git', ['-C', dir, 'checkout', branch], { stdio: 'pipe' });
}

function makeInput(overrides?: Partial<JudgeInput>): JudgeInput {
  return {
    worktree: '/tmp/wt',
    branch: 'feat-1',
    baseBranch: 'main',
    outputFile: null,
    exitCode: 0,
    phase: 'development',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────

describe('CompletionJudge', () => {
  let judge: CompletionJudge;
  let tempDir: string;

  beforeEach(() => {
    judge = new CompletionJudge();
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('development phase', () => {
    it('returns completed when branch has local commits ahead', () => {
      initGitRepo(tempDir);
      createBranch(tempDir, 'feat-1');
      addCommit(tempDir, 'feature.ts', 'code', 'feat: add feature');

      // Need to simulate origin/main — create a bare remote
      const bareDir = makeTempDir();
      execFileSync('git', ['clone', '--bare', tempDir, bareDir], { stdio: 'pipe' });
      execFileSync('git', ['-C', tempDir, 'remote', 'add', 'origin', bareDir], { stdio: 'pipe' });
      execFileSync('git', ['-C', tempDir, 'push', 'origin', 'main'], { stdio: 'pipe' });

      const result = judge.judge(makeInput({
        worktree: tempDir,
        branch: 'feat-1',
        baseBranch: 'main',
      }));

      expect(result.status).toBe('completed');
      expect(result.reason).toBe('branch_local_commits');

      rmSync(bareDir, { recursive: true, force: true });
    });

    it('returns completed when branch is pushed with commits ahead', () => {
      initGitRepo(tempDir);
      createBranch(tempDir, 'feat-2');
      addCommit(tempDir, 'feature.ts', 'code', 'feat: add feature');

      const bareDir = makeTempDir();
      execFileSync('git', ['clone', '--bare', tempDir, bareDir], { stdio: 'pipe' });
      execFileSync('git', ['-C', tempDir, 'remote', 'add', 'origin', bareDir], { stdio: 'pipe' });
      execFileSync('git', ['-C', tempDir, 'push', 'origin', 'main'], { stdio: 'pipe' });
      execFileSync('git', ['-C', tempDir, 'push', 'origin', 'feat-2'], { stdio: 'pipe' });

      const result = judge.judge(makeInput({
        worktree: tempDir,
        branch: 'feat-2',
        baseBranch: 'main',
      }));

      expect(result.status).toBe('completed');
      expect(result.reason).toBe('branch_pushed');

      rmSync(bareDir, { recursive: true, force: true });
    });

    it('returns completed when marker file exists', () => {
      initGitRepo(tempDir);
      createBranch(tempDir, 'feat-marker');
      // Add a unique commit on the branch so it diverges
      addCommit(tempDir, 'marker-work.ts', 'work', 'feat: marker work');

      const logsDir = join(tempDir, 'logs');
      mkdirSync(logsDir);
      writeFileSync(join(logsDir, 'task_completed'), '');

      // Diverge main so branch is not considered merged
      checkoutBranch(tempDir, 'main');
      addCommit(tempDir, 'main-diverge.ts', 'diverge', 'chore: diverge main');

      const bareDir = makeTempDir();
      execFileSync('git', ['clone', '--bare', tempDir, bareDir], { stdio: 'pipe' });
      execFileSync('git', ['-C', tempDir, 'remote', 'add', 'origin', bareDir], { stdio: 'pipe' });
      execFileSync('git', ['-C', tempDir, 'push', 'origin', 'main'], { stdio: 'pipe' });
      checkoutBranch(tempDir, 'feat-marker');

      const result = judge.judge(makeInput({
        worktree: tempDir,
        branch: 'feat-marker',
        baseBranch: 'main',
        logsDir,
      }));

      expect(result.status).toBe('completed');
      expect(result.reason).toBe('marker_file');

      rmSync(bareDir, { recursive: true, force: true });
    });

    it('returns incomplete with no artifacts and exit code 0', () => {
      // No remote set up — simulates worker crash before any work done
      // All git artifact checks fail gracefully, falling through to no_artifacts
      initGitRepo(tempDir);
      createBranch(tempDir, 'feat-empty');

      const result = judge.judge(makeInput({
        worktree: tempDir,
        branch: 'feat-empty',
        baseBranch: 'main',
        exitCode: 0,
      }));

      expect(result.status).toBe('incomplete');
      expect(result.reason).toBe('no_artifacts');
    });

    it('returns failed with non-zero exit code and no artifacts', () => {
      // No remote — git checks fail, falls through to crash detection
      initGitRepo(tempDir);
      createBranch(tempDir, 'feat-crash');

      const result = judge.judge(makeInput({
        worktree: tempDir,
        branch: 'feat-crash',
        baseBranch: 'main',
        exitCode: 1,
      }));

      expect(result.status).toBe('failed');
      expect(result.reason).toBe('crash(1)');
    });

    it('returns completed when branch is already merged to base', () => {
      initGitRepo(tempDir);
      createBranch(tempDir, 'feat-merged');
      addCommit(tempDir, 'feature.ts', 'code', 'feat: done');
      checkoutBranch(tempDir, 'main');
      execFileSync('git', ['-C', tempDir, 'merge', 'feat-merged'], { stdio: 'pipe' });

      const bareDir = makeTempDir();
      execFileSync('git', ['clone', '--bare', tempDir, bareDir], { stdio: 'pipe' });
      execFileSync('git', ['-C', tempDir, 'remote', 'add', 'origin', bareDir], { stdio: 'pipe' });
      execFileSync('git', ['-C', tempDir, 'push', 'origin', 'main'], { stdio: 'pipe' });
      // Push the feature branch too — simulates worker having pushed their work
      execFileSync('git', ['-C', tempDir, 'push', 'origin', 'feat-merged'], { stdio: 'pipe' });
      checkoutBranch(tempDir, 'feat-merged');

      const result = judge.judge(makeInput({
        worktree: tempDir,
        branch: 'feat-merged',
        baseBranch: 'main',
      }));

      expect(result.status).toBe('completed');
      expect(result.reason).toBe('already_merged');

      rmSync(bareDir, { recursive: true, force: true });
    });
  });

  describe('integration phase', () => {
    it('returns completed when branch is merged', () => {
      initGitRepo(tempDir);
      createBranch(tempDir, 'feat-int');
      addCommit(tempDir, 'feature.ts', 'code', 'feat: done');
      checkoutBranch(tempDir, 'main');
      execFileSync('git', ['-C', tempDir, 'merge', 'feat-int'], { stdio: 'pipe' });

      const bareDir = makeTempDir();
      execFileSync('git', ['clone', '--bare', tempDir, bareDir], { stdio: 'pipe' });
      execFileSync('git', ['-C', tempDir, 'remote', 'add', 'origin', bareDir], { stdio: 'pipe' });
      execFileSync('git', ['-C', tempDir, 'push', 'origin', 'main'], { stdio: 'pipe' });
      execFileSync('git', ['-C', tempDir, 'push', 'origin', 'feat-int'], { stdio: 'pipe' });
      checkoutBranch(tempDir, 'feat-int');

      const result = judge.judge(makeInput({
        worktree: tempDir,
        branch: 'feat-int',
        baseBranch: 'main',
        phase: 'integration',
      }));

      expect(result.status).toBe('completed');
      expect(result.reason).toBe('already_merged');

      rmSync(bareDir, { recursive: true, force: true });
    });

    it('returns incomplete when exit 0 but not merged', () => {
      // No remote — isMergedToBase fails, falls to integration path
      initGitRepo(tempDir);
      createBranch(tempDir, 'feat-int-nomerge');

      const result = judge.judge(makeInput({
        worktree: tempDir,
        branch: 'feat-int-nomerge',
        baseBranch: 'main',
        phase: 'integration',
        exitCode: 0,
      }));

      expect(result.status).toBe('incomplete');
      expect(result.reason).toBe('integration_not_merged');
    });

    it('returns failed on crash in integration', () => {
      initGitRepo(tempDir);
      createBranch(tempDir, 'feat-int-crash');

      const result = judge.judge(makeInput({
        worktree: tempDir,
        branch: 'feat-int-crash',
        baseBranch: 'main',
        phase: 'integration',
        exitCode: 137,
      }));

      expect(result.status).toBe('failed');
      expect(result.reason).toBe('crash(137)');
    });
  });
});
