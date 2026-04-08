/**
 * @module        projectPipelineAdapter
 * @description   流水线 YAML 配置与引擎之间的适配层
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-04-02
 * @updated       2026-04-03
 *
 * @role          util
 * @layer         core
 * @boundedContext pipeline
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ProjectConfig } from './config.js';

// ─── Types ──────────────────────────────────────────────────────

/** Card state names — configurable via YAML, defaults to current values */
export interface CardStates {
  planning: string;
  backlog: string;
  ready: string;      // "Todo" equivalent
  active: string;     // "Inprogress" equivalent
  review: string;     // "QA" equivalent
  done: string;
}

/** A single pipeline stage definition */
export interface StageDefinition {
  name: string;
  /** Which card state triggers this stage */
  triggerState: string;
  /** Card state while this stage is active */
  activeState: string;
  /** Agent to use (claude/codex/gemini) */
  agent: string;
  /** Optional profile to load */
  profile?: string;
  /** Completion strategy: git-evidence, fast-forward-merge, exit-code */
  completion: string;
  /** On complete: which state to move card to */
  onCompleteState: string;
  /** On fail: label to add */
  onFailLabel?: string;
  /** On fail: comment to add */
  onFailComment?: string;
  /** Integration queue mode (fifo for integration stages) */
  queue?: string;
  /** Timeout override for this stage */
  timeout?: string;
}

export interface ProjectPipelineSettings {
  /** Whether git operations (branch, worktree, merge) are enabled. Default true. */
  gitEnabled: boolean;
  states: CardStates;
  stages: StageDefinition[];
  /** All non-Done states to check for pipeline completion */
  activeStates: string[];
  /** Labels to clean when cards re-enter backlog */
  auxiliaryLabels: string[];
}

// ─── Defaults (exact match of current hardcoded behavior) ────────

const DEFAULT_STATES: CardStates = {
  planning: 'Planning',
  backlog: 'Backlog',
  ready: 'Todo',
  active: 'Inprogress',
  review: 'QA',
  done: 'Done',
};

const DEFAULT_AUXILIARY_LABELS = [
  'BLOCKED', 'NEEDS-FIX', 'CONFLICT', 'WAITING-CONFIRMATION', 'STALE-RUNTIME', 'CLAIMED',
];

function defaultStages(config: ProjectConfig): StageDefinition[] {
  const tool = config.WORKER_TOOL || 'claude';
  return [
    {
      name: 'develop',
      triggerState: 'Todo',
      activeState: 'Inprogress',
      agent: tool,
      completion: 'git-evidence',
      onCompleteState: 'QA',
      onFailLabel: 'NEEDS-FIX',
      onFailComment: 'Worker failed. Marked as NEEDS-FIX.',
    },
    {
      name: 'integrate',
      triggerState: 'QA',
      activeState: 'QA',
      agent: config.ACP_AGENT || tool,
      completion: 'fast-forward-merge',
      onCompleteState: 'Done',
      queue: 'fifo',
    },
  ];
}

// ─── Adapter ────────────────────────────────────────────────────

export class ProjectPipelineAdapter {
  readonly settings: ProjectPipelineSettings;

  constructor(config: ProjectConfig, projectDir?: string) {
    const yamlConfig = loadProjectPipelineYaml(config.PROJECT_NAME, projectDir);

    if (yamlConfig) {
      this.settings = buildFromYaml(yamlConfig, config);
    } else {
      this.settings = buildDefaults(config);
    }
  }

  /** Whether git operations are enabled */
  get gitEnabled(): boolean {
    return this.settings.gitEnabled;
  }

  /** Get card state names */
  get states(): CardStates {
    return this.settings.states;
  }

  /** Get all stage definitions */
  get stages(): StageDefinition[] {
    return this.settings.stages;
  }

  /** Find stage by name */
  getStage(name: string): StageDefinition | undefined {
    return this.settings.stages.find(s => s.name === name);
  }

  /** Find stage by trigger state (which PM state activates it) */
  getStageByTrigger(pmState: string): StageDefinition | undefined {
    return this.settings.stages.find(s => s.triggerState === pmState);
  }

  /** Get the first stage (responsible for prepare: branch + worktree) */
  get firstStage(): StageDefinition {
    return this.settings.stages[0];
  }

  /** Get the last stage (responsible for release: worktree cleanup) */
  get lastStage(): StageDefinition {
    return this.settings.stages[this.settings.stages.length - 1];
  }

  /**
   * @deprecated Use firstStage instead. Kept for backward compatibility during migration.
   */
  get developStage(): StageDefinition {
    return this.settings.stages[0];
  }

  /**
   * @deprecated Use lastStage or getStage() instead. Kept for backward compatibility during migration.
   */
  get integrateStage(): StageDefinition | undefined {
    return this.settings.stages.find(s => s.queue === 'fifo')
      || this.settings.stages[this.settings.stages.length - 1];
  }

  /** Find the stage whose activeState matches the given PM state */
  getStageByActiveState(pmState: string): StageDefinition | undefined {
    return this.settings.stages.find(s => s.activeState === pmState);
  }

  /** All states where cards are "active" (not done, not backlog) */
  get activeStates(): string[] {
    return this.settings.activeStates;
  }

  /** Labels to clean when card goes back to backlog */
  get auxiliaryLabels(): string[] {
    return this.settings.auxiliaryLabels;
  }

  /** Derive PM state from lease phase */
  derivePmState(leasePhase: string, currentPmState?: string): string {
    const s = this.settings.states;
    switch (leasePhase) {
      case 'queued':
      case 'preparing':
        return s.ready;
      case 'coding':
        return s.active;
      case 'merging':
      case 'resolving_conflict':
      case 'closing':
        return s.review;
      case 'waiting_confirmation':
        return currentPmState === s.review ? s.review : s.active;
      default:
        return s.ready;
    }
  }
}

// ─── YAML Loading ───────────────────────────────────────────────

/** Resolve pipelines dir: ~/.coral/projects/<name>/pipelines/ with legacy fallback */
function resolvePipelinesDir(projectName: string, projectDir?: string): string | null {
  const coralDir = resolve(homedir(), '.coral', 'projects', projectName, 'pipelines');
  if (existsSync(coralDir)) return coralDir;
  // Legacy fallback: <repo>/.sps/pipelines/
  if (projectDir) {
    const legacyDir = resolve(projectDir, '.sps', 'pipelines');
    if (existsSync(legacyDir)) return legacyDir;
  }
  return null;
}

/** Path to the active pipeline marker file */
function activePipelinePath(projectName: string): string {
  return resolve(homedir(), '.coral', 'projects', projectName, 'active-pipeline');
}

/** Read the active pipeline name */
export function getActivePipelineName(projectName: string): string | null {
  try {
    const marker = readFileSync(activePipelinePath(projectName), 'utf-8').trim();
    return marker || null;
  } catch { return null; }
}

/** Set the active pipeline name */
export function setActivePipeline(projectName: string, name: string): void {
  const dir = resolve(homedir(), '.coral', 'projects', projectName);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(activePipelinePath(projectName), name + '\n');
}

function loadProjectPipelineYaml(projectName: string, projectDir?: string): any | null {
  const pipelinesDir = resolvePipelinesDir(projectName, projectDir);
  if (!pipelinesDir) return null;

  // Check for explicitly activated pipeline
  const activeName = getActivePipelineName(projectName);
  if (activeName) {
    for (const ext of ['.yaml', '.yml']) {
      const filePath = resolve(pipelinesDir, activeName + ext);
      if (existsSync(filePath)) {
        try {
          const parsed = parseYaml(readFileSync(filePath, 'utf-8'));
          if (parsed?.mode === 'project') return parsed;
        } catch { /* skip unparseable */ }
      }
    }
  }

  // Fallback: find first mode:project YAML
  try {
    const files = readdirSync(pipelinesDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    for (const file of files) {
      try {
        const raw = readFileSync(resolve(pipelinesDir, file), 'utf-8');
        const parsed = parseYaml(raw);
        if (parsed?.mode === 'project') return parsed;
      } catch { /* skip unparseable */ }
    }
  } catch { /* dir unreadable */ }

  return null;
}

function buildFromYaml(yaml: any, config: ProjectConfig): ProjectPipelineSettings {
  // Card states: merge YAML over defaults
  const states: CardStates = {
    ...DEFAULT_STATES,
    ...(yaml.pm?.card_states || {}),
  };

  // Stages: build from YAML or use defaults
  let stages: StageDefinition[];
  if (yaml.stages && Array.isArray(yaml.stages) && yaml.stages.length > 0) {
    const yamlStages = yaml.stages as any[];
    stages = yamlStages.map((s: any, idx: number) => {
      // Default on_complete fallback: next stage's trigger state, or done for last stage
      const nextTrigger = idx < yamlStages.length - 1
        ? (parseTrigger(yamlStages[idx + 1].trigger) || yamlStages[idx + 1].card_state || states.done)
        : states.done;
      return {
        name: s.name,
        triggerState: parseTrigger(s.trigger) || s.card_state || states.ready,
        activeState: s.card_state || states.active,
        agent: s.agent || config.WORKER_TOOL || 'claude',
        profile: s.profile,
        completion: s.completion || 'git-evidence',
        onCompleteState: parseOnComplete(s.on_complete, nextTrigger),
        onFailLabel: parseOnFailLabel(s.on_fail),
        onFailComment: parseOnFailComment(s.on_fail),
        queue: s.queue,
        timeout: s.timeout,
      };
    });
  } else {
    stages = defaultStages(config);
    // Remap default stages to use custom state names
    stages[0].triggerState = states.ready;
    stages[0].activeState = states.active;
    stages[0].onCompleteState = states.review;
    stages[1].triggerState = states.review;
    stages[1].activeState = states.review;
    stages[1].onCompleteState = states.done;
  }

  // Derive activeStates from stages (all non-done states)
  const activeStateSet = new Set<string>();
  if (states.planning) activeStateSet.add(states.planning);
  activeStateSet.add(states.backlog);
  activeStateSet.add(states.ready);
  for (const stage of stages) {
    if (stage.triggerState) activeStateSet.add(stage.triggerState);
    if (stage.activeState) activeStateSet.add(stage.activeState);
  }
  const activeStates = Array.from(activeStateSet);

  // Git mode: default true, can be disabled via YAML
  const gitEnabled = yaml.git !== false;

  // Validate: git-dependent completion strategies require git
  if (!gitEnabled) {
    for (const stage of stages) {
      if (stage.completion === 'git-evidence' || stage.completion === 'fast-forward-merge') {
        throw new Error(
          `Stage "${stage.name}" uses completion: ${stage.completion} but git is disabled (git: false). ` +
          `Use completion: exit-code when git: false.`
        );
      }
    }
    // Default completion for git:false — override any implicit git-evidence defaults
    for (const stage of stages) {
      if (!stage.completion || stage.completion === 'git-evidence') {
        stage.completion = 'exit-code';
      }
    }
  }

  return {
    gitEnabled,
    states,
    stages,
    activeStates,
    auxiliaryLabels: DEFAULT_AUXILIARY_LABELS,
  };
}

function buildDefaults(config: ProjectConfig): ProjectPipelineSettings {
  return {
    gitEnabled: true,
    states: { ...DEFAULT_STATES },
    stages: defaultStages(config),
    activeStates: ['Planning', 'Backlog', 'Todo', 'Inprogress', 'QA'],
    auxiliaryLabels: DEFAULT_AUXILIARY_LABELS,
  };
}

// ─── YAML Field Parsers ─────────────────────────────────────────

/** Parse "card_enters 'Todo'" → "Todo" */
function parseTrigger(raw?: string): string | undefined {
  if (!raw) return undefined;
  const match = raw.match(/card_enters\s+["']?(\S+?)["']?\s*$/);
  return match ? match[1] : raw;
}

/** Parse on_complete to target state. fallbackState is used when on_complete is not defined. */
function parseOnComplete(raw: any, fallbackState: string): string {
  if (!raw) return fallbackState;
  if (typeof raw === 'string') {
    const match = raw.match(/move_card\s+["']?(\S+?)["']?\s*$/);
    return match ? match[1] : raw;
  }
  if (typeof raw === 'object' && raw.action) {
    const match = raw.action.match(/move_card\s+["']?(\S+?)["']?\s*$/);
    return match ? match[1] : fallbackState;
  }
  return fallbackState;
}

/** Parse on_fail to label */
function parseOnFailLabel(raw: any): string | undefined {
  if (!raw) return 'NEEDS-FIX';
  if (typeof raw === 'string') {
    const match = raw.match(/label\s+["']?(\S+?)["']?\s*$/);
    return match ? match[1] : undefined;
  }
  if (typeof raw === 'object' && raw.action) {
    const match = raw.action.match(/label\s+["']?(\S+?)["']?\s*$/);
    return match ? match[1] : undefined;
  }
  return undefined;
}

/** Parse on_fail to comment */
function parseOnFailComment(raw: any): string | undefined {
  if (typeof raw === 'object' && raw.comment) return raw.comment;
  return undefined;
}
