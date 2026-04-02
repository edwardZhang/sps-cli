/**
 * ProjectPipelineAdapter — bridges pipeline YAML config with existing engines.
 *
 * When a mode:project YAML exists, it drives card states, stage definitions,
 * and per-stage agent/profile. When no YAML exists, returns defaults that
 * exactly match current hardcoded behavior (zero behavior change).
 *
 * Engines use this adapter instead of hardcoded string literals.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
    const yamlConfig = loadProjectPipelineYaml(projectDir || config.PROJECT_DIR);

    if (yamlConfig) {
      this.settings = buildFromYaml(yamlConfig, config);
    } else {
      this.settings = buildDefaults(config);
    }
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

  /** Get the development stage (first stage) */
  get developStage(): StageDefinition {
    return this.settings.stages[0];
  }

  /** Get the integration stage (last stage, or stage with queue:fifo) */
  get integrateStage(): StageDefinition | undefined {
    return this.settings.stages.find(s => s.queue === 'fifo')
      || this.settings.stages[this.settings.stages.length - 1];
  }

  /** Is this a development-phase state? */
  isDevelopmentState(pmState: string): boolean {
    return pmState === this.settings.states.active;
  }

  /** Is this a review/integration-phase state? */
  isReviewState(pmState: string): boolean {
    return pmState === this.settings.states.review;
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

function loadProjectPipelineYaml(projectDir?: string): any | null {
  if (!projectDir) return null;

  const pipelinesDir = resolve(projectDir, '.sps', 'pipelines');
  if (!existsSync(pipelinesDir)) return null;

  // Find first mode:project YAML
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
    stages = yaml.stages.map((s: any) => ({
      name: s.name,
      triggerState: parseTrigger(s.trigger) || s.card_state || states.ready,
      activeState: s.card_state || states.active,
      agent: s.agent || config.WORKER_TOOL || 'claude',
      profile: s.profile,
      completion: s.completion || 'git-evidence',
      onCompleteState: parseOnComplete(s.on_complete, states),
      onFailLabel: parseOnFailLabel(s.on_fail),
      onFailComment: parseOnFailComment(s.on_fail),
      queue: s.queue,
      timeout: s.timeout,
    }));
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

  const activeStates = [states.planning, states.backlog, states.ready, states.active, states.review];

  return {
    states,
    stages,
    activeStates,
    auxiliaryLabels: DEFAULT_AUXILIARY_LABELS,
  };
}

function buildDefaults(config: ProjectConfig): ProjectPipelineSettings {
  return {
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

/** Parse on_complete to target state */
function parseOnComplete(raw: any, states: CardStates): string {
  if (!raw) return states.review;
  if (typeof raw === 'string') {
    const match = raw.match(/move_card\s+["']?(\S+?)["']?\s*$/);
    return match ? match[1] : raw;
  }
  if (typeof raw === 'object' && raw.action) {
    const match = raw.action.match(/move_card\s+["']?(\S+?)["']?\s*$/);
    return match ? match[1] : states.review;
  }
  return states.review;
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
