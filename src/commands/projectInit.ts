import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger } from '../core/logger.js';

const HOME = process.env.HOME || '/home/coral';
const __dirname = dirname(fileURLToPath(import.meta.url));

// Look for project-template relative to the package root (works for both npm install and source)
function findTemplateDir(): string {
  // When installed via npm: dist/commands/projectInit.js → ../../project-template
  const npmPath = resolve(__dirname, '..', '..', 'project-template');
  if (existsSync(npmPath)) return npmPath;
  // When running from source repo: src/commands/ → ../../../project-template
  const srcPath = resolve(__dirname, '..', '..', '..', 'project-template');
  if (existsSync(srcPath)) return srcPath;
  // Legacy fallback
  const legacyPath = resolve(HOME, 'jarvis-skills', 'coding-work-flow', 'project-template');
  if (existsSync(legacyPath)) return legacyPath;
  return npmPath; // default, will fail gracefully below
}

const TEMPLATE_DIR = findTemplateDir();

export async function executeProjectInit(
  project: string,
  flags: Record<string, boolean>,
): Promise<void> {
  const log = new Logger('project-init', project);

  if (!project) {
    log.error('Usage: sps project init <project>');
    process.exit(2);
  }

  const instanceDir = resolve(HOME, '.coral', 'projects', project);

  if (existsSync(instanceDir) && !flags.force) {
    log.error(`Project directory already exists: ${instanceDir}`);
    log.info('Use --force to overwrite templates (conf will NOT be overwritten)');
    process.exit(1);
  }

  // Create directory structure
  const dirs = [
    instanceDir,
    resolve(instanceDir, 'logs'),
    resolve(instanceDir, 'pm_meta'),
    resolve(instanceDir, 'runtime'),
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      log.ok(`Created ${dir}`);
    }
  }

  // Copy batch_scheduler.sh
  const schedulerSrc = resolve(TEMPLATE_DIR, 'batch_scheduler.sh');
  const schedulerDst = resolve(instanceDir, 'batch_scheduler.sh');
  if (existsSync(schedulerSrc)) {
    copyFileSync(schedulerSrc, schedulerDst);
    chmodSync(schedulerDst, 0o755);
    log.ok('Installed batch_scheduler.sh (thin wrapper → sps tick)');
  }

  // Copy deploy.sh
  const deploySrc = resolve(TEMPLATE_DIR, 'deploy.sh');
  const deployDst = resolve(instanceDir, 'deploy.sh');
  if (existsSync(deploySrc) && !existsSync(deployDst)) {
    copyFileSync(deploySrc, deployDst);
    chmodSync(deployDst, 0o755);
    log.ok('Installed deploy.sh');
  }

  // Generate conf from template (only if conf doesn't exist)
  const confDst = resolve(instanceDir, 'conf');
  if (!existsSync(confDst)) {
    const templateSrc = resolve(TEMPLATE_DIR, 'conf.template');
    if (existsSync(templateSrc)) {
      let content = readFileSync(templateSrc, 'utf-8');
      content = content.replace(/__PROJECT_NAME__/g, project);
      content = content.replace(/__PROJECT_DISPLAY__/g, project);
      writeFileSync(confDst, content);
      log.ok('Generated conf from template (edit to fill in values)');
    }
  } else {
    log.info('conf already exists, skipping (use --force to regenerate templates)');
  }

  // Create empty pipeline_order.json if not exists
  const orderFile = resolve(instanceDir, 'pipeline_order.json');
  if (!existsSync(orderFile)) {
    writeFileSync(orderFile, '[]\n');
    log.ok('Created empty pipeline_order.json');
  }

  log.ok(`Project ${project} initialized at ${instanceDir}`);
  log.info('Next steps:');
  log.info(`  1. Edit ${confDst} to fill in GitLab/PM/Notification settings`);
  log.info(`  2. Run: sps doctor ${project} --fix`);
  log.info(`  3. Run: sps card add ${project} "task title" "description"`);
  log.info(`  4. Run: sps tick ${project}`);
}
