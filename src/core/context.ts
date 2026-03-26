import { loadProjectConf, validateConfig, type ProjectConfig } from './config.js';
import { resolveProjectPaths, type ProjectPaths } from './paths.js';

export class ProjectContext {
  readonly projectName: string;
  config: ProjectConfig;
  paths: ProjectPaths;

  private constructor(projectName: string, config: ProjectConfig, paths: ProjectPaths) {
    this.projectName = projectName;
    this.config = config;
    this.paths = paths;
  }

  static load(projectName: string): ProjectContext {
    const config = loadProjectConf(projectName);
    const paths = resolveProjectPaths(projectName, {
      projectDir: config.PROJECT_DIR,
      worktreeDir: config.WORKTREE_DIR,
    });
    return new ProjectContext(projectName, config, paths);
  }

  /**
   * Reload project configuration from disk.
   * Called at the start of each tick cycle to pick up conf changes without restarting.
   */
  reload(): void {
    this.config = loadProjectConf(this.projectName);
    this.paths = resolveProjectPaths(this.projectName, {
      projectDir: this.config.PROJECT_DIR,
      worktreeDir: this.config.WORKTREE_DIR,
    });
  }

  validate(): { ok: boolean; errors: { field: string; message: string }[] } {
    const errors = validateConfig(this.config);
    return { ok: errors.length === 0, errors };
  }

  /** Shorthand for common config access */
  get pmTool() { return this.config.PM_TOOL; }
  get workerTool() { return this.config.WORKER_TOOL; }
  get maxWorkers() { return this.config.MAX_CONCURRENT_WORKERS; }
  get ciMode() { return this.config.CI_MODE; }
  get mrMode() { return this.config.MR_MODE; }
  get mergeBranch() { return this.config.GITLAB_MERGE_BRANCH; }
}
