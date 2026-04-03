/**
 * @module        pipelineConfig
 * @description   流水线 YAML 配置加载与校验
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-04-02
 * @updated       2026-04-03
 *
 * @role          config
 * @layer         core
 * @boundedContext pipeline
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

// ─── Types ──────────────────────────────────────────────────────

export type PipelineMode = 'steps' | 'project';
export type OnFail = 'abort' | 'skip' | { retry: number } | { goto: string };

export interface StepConfig {
  /** Step name (unique within pipeline) */
  name: string;
  /** Agent step: agent type (claude/codex/gemini/custom) */
  agent?: string;
  /** Agent step: profile to load */
  profile?: string;
  /** Agent step: daemon session name (for context reuse across steps) */
  session?: string;
  /** Agent step: prompt text (supports ${VAR} substitution) */
  prompt?: string;
  /** Agent step: load prompt from file */
  prompt_file?: string;
  /** Shell step: command to execute */
  run?: string;
  /** Failure handling */
  on_fail?: string; // parsed into OnFail
  /** Timeout for this step */
  timeout?: string;
  /** Mark as final step — output goes directly to user */
  final?: boolean;
}

export interface StepsPipelineConfig {
  name: string;
  description?: string;
  mode: 'steps';
  steps: StepConfig[];
}

export interface ProjectPipelineConfig {
  name: string;
  description?: string;
  mode: 'project';
  pm?: {
    provider?: string;
    card_states?: Record<string, string>;
  };
  stages?: Array<{
    name: string;
    trigger?: string;
    agent?: string;
    profile?: string;
    card_state?: string;
    prompt?: string;
    completion?: string;
    git?: { branch?: boolean; worktree?: string };
    queue?: string;
    on_complete?: Record<string, string> | string;
    on_fail?: Record<string, string> | string;
    timeout?: string;
  }>;
  workers?: { max?: number; restart_limit?: number };
  notifications?: { matrix?: boolean };
}

export type PipelineConfig = StepsPipelineConfig | ProjectPipelineConfig;

export interface PipelineInfo {
  name: string;
  description: string;
  mode: PipelineMode;
  filePath: string;
}

// ─── Parsing ────────────────────────────────────────────────────

/**
 * Parse on_fail string into structured OnFail type.
 * Formats: "abort", "skip", "retry 3", "goto step_name"
 */
export function parseOnFail(raw?: string): OnFail {
  if (!raw || raw === 'abort') return 'abort';
  if (raw === 'skip') return 'skip';
  const retryMatch = raw.match(/^retry\s+(\d+)$/);
  if (retryMatch) return { retry: parseInt(retryMatch[1], 10) };
  const gotoMatch = raw.match(/^goto\s+(\S+)$/);
  if (gotoMatch) return { goto: gotoMatch[1] };
  throw new Error(`Invalid on_fail value: "${raw}". Expected: abort, skip, retry N, or goto <step_name>`);
}

/**
 * Parse timeout string (e.g., "30m", "2h", "300s") into milliseconds.
 */
export function parseTimeout(raw?: string): number | undefined {
  if (!raw) return undefined;
  const match = raw.match(/^(\d+)(s|m|h)$/);
  if (!match) throw new Error(`Invalid timeout: "${raw}". Expected format: 30s, 5m, 2h`);
  const value = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === 's') return value * 1000;
  if (unit === 'm') return value * 60 * 1000;
  return value * 3600 * 1000;
}

// ─── Validation ─────────────────────────────────────────────────

function validateStepsPipeline(config: StepsPipelineConfig, filePath: string): void {
  if (!config.steps || !Array.isArray(config.steps) || config.steps.length === 0) {
    throw new Error(`Pipeline "${config.name}" (${filePath}): mode "steps" requires at least one step`);
  }

  const names = new Set<string>();
  for (const step of config.steps) {
    if (!step.name) {
      throw new Error(`Pipeline "${config.name}" (${filePath}): every step must have a "name" field`);
    }
    if (names.has(step.name)) {
      throw new Error(`Pipeline "${config.name}" (${filePath}): duplicate step name "${step.name}"`);
    }
    names.add(step.name);

    if (!step.agent && !step.run) {
      throw new Error(`Pipeline "${config.name}" (${filePath}): step "${step.name}" must have either "agent" or "run"`);
    }
    if (step.agent && step.run) {
      throw new Error(`Pipeline "${config.name}" (${filePath}): step "${step.name}" cannot have both "agent" and "run"`);
    }
    if (step.agent && !step.prompt && !step.prompt_file) {
      throw new Error(`Pipeline "${config.name}" (${filePath}): agent step "${step.name}" must have "prompt" or "prompt_file"`);
    }

    // Validate on_fail references
    if (step.on_fail) {
      const parsed = parseOnFail(step.on_fail);
      if (typeof parsed === 'object' && 'goto' in parsed) {
        // Can't validate goto target until all steps are parsed — defer
      }
    }
  }

  // Second pass: validate goto targets
  for (const step of config.steps) {
    if (step.on_fail) {
      const parsed = parseOnFail(step.on_fail);
      if (typeof parsed === 'object' && 'goto' in parsed && !names.has(parsed.goto)) {
        throw new Error(`Pipeline "${config.name}" (${filePath}): step "${step.name}" has on_fail goto "${parsed.goto}" but no step with that name exists`);
      }
    }
  }
}

// ─── Loading ────────────────────────────────────────────────────

/**
 * Get the pipelines directory path for the current working directory.
 */
export function getPipelinesDir(cwd?: string): string {
  return resolve(cwd || process.cwd(), '.sps', 'pipelines');
}

/**
 * List all available pipelines.
 */
export function listPipelines(cwd?: string): PipelineInfo[] {
  const dir = getPipelinesDir(cwd);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  const pipelines: PipelineInfo[] = [];

  for (const file of files) {
    const filePath = resolve(dir, file);
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = parseYaml(raw);
      pipelines.push({
        name: parsed.name || basename(file, file.endsWith('.yaml') ? '.yaml' : '.yml'),
        description: parsed.description || '',
        mode: parsed.mode || 'steps',
        filePath,
      });
    } catch {
      // Skip unparseable files
    }
  }

  return pipelines;
}

/**
 * Load and validate a pipeline by name.
 * Searches .sps/pipelines/ for a matching YAML file.
 */
export function loadPipelineConfig(name: string, cwd?: string): PipelineConfig {
  const dir = getPipelinesDir(cwd);
  const candidates = [
    resolve(dir, `${name}.yaml`),
    resolve(dir, `${name}.yml`),
  ];

  let filePath: string | null = null;
  for (const c of candidates) {
    if (existsSync(c)) { filePath = c; break; }
  }

  if (!filePath) {
    const available = listPipelines(cwd);
    const names = available.map(p => p.name).join(', ');
    throw new Error(
      `Pipeline "${name}" not found in ${dir}\n` +
      (names ? `Available pipelines: ${names}` : 'No pipelines found. Create .sps/pipelines/<name>.yaml'),
    );
  }

  const raw = readFileSync(filePath, 'utf-8');
  let parsed: any;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Pipeline file ${filePath} is empty or invalid`);
  }

  // Set defaults
  const config: PipelineConfig = {
    name: parsed.name || name,
    description: parsed.description,
    mode: parsed.mode || 'steps',
    ...parsed,
  };

  // Validate based on mode
  const mode = config.mode;
  if (mode === 'steps') {
    validateStepsPipeline(config as StepsPipelineConfig, filePath);
  } else if (mode === 'project') {
    // Phase C validation — for now just accept
  } else {
    throw new Error(`Pipeline "${(config as any).name}" (${filePath}): unknown mode "${mode}". Expected: steps or project`);
  }

  return config;
}
