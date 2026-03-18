import { loadProjectConf, validateConfig, type ProjectConfig } from './config.js';
import { resolveProjectPaths, type ProjectPaths } from './paths.js';

export class ProjectContext {
  readonly projectName: string;
  readonly config: ProjectConfig;
  readonly paths: ProjectPaths;

  private constructor(projectName: string, config: ProjectConfig, paths: ProjectPaths) {
    this.projectName = projectName;
    this.config = config;
    this.paths = paths;
  }

  static load(projectName: string): ProjectContext {
    const paths = resolveProjectPaths(projectName);
    const config = loadProjectConf(projectName);
    return new ProjectContext(projectName, config, paths);
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
  get mergeBranch() { return this.config.GITLAB_MERGE_BRANCH; }
}
