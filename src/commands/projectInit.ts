import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '../core/logger.js';

const HOME = process.env.HOME || '/home/coral';
const TEMPLATE_DIR = resolve(HOME, 'jarvis-skills', 'coding-work-flow', 'project-template');

export async function executeProjectInit(
  project: string,
  flags: Record<string, boolean>,
): Promise<void> {
  const log = new Logger('project-init', project);

  if (!project) {
    log.error('Usage: sps project init <project>');
    process.exit(2);
  }

  const instanceDir = resolve(HOME, '.projects', project);

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
