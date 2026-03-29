import type { ProjectContext } from '../core/context.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import type { Notifier } from '../interfaces/Notifier.js';
import type { CommandResult, ActionRecord, Card } from '../models/types.js';
import { readState } from '../core/state.js';
import { readQueue, removeFromQueue } from '../core/queue.js';
import { Logger } from '../core/logger.js';

export class SchedulerEngine {
  private log: Logger;

  constructor(
    private ctx: ProjectContext,
    private taskBackend: TaskBackend,
    private notifier?: Notifier,
  ) {
    this.log = new Logger('scheduler', ctx.projectName, ctx.paths.logsDir);
  }

  async tick(opts: { dryRun?: boolean } = {}): Promise<CommandResult> {
    const actions: ActionRecord[] = [];
    const result: CommandResult = {
      project: this.ctx.projectName,
      component: 'scheduler',
      status: 'ok',
      exitCode: 0,
      actions,
      recommendedActions: [],
      details: {},
    };

    try {
      // 1. Read state to check slots and active cards
      const state = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);

      // 2. Get Planning cards from PM
      const planningCards = await this.taskBackend.listByState('Planning');
      const pipelineLabel = this.ctx.config.PIPELINE_LABEL || 'AI-PIPELINE';

      // Filter to AI-PIPELINE cards only
      const eligibleCards = planningCards.filter((c) => c.labels.includes(pipelineLabel));

      if (eligibleCards.length === 0) {
        this.log.info('No eligible Planning cards');
        result.details = { reason: 'no_eligible_card' };
        return result;
      }

      // 3. Determine processing order:
      //    - If pipeline_order.json has entries → use that order
      //    - Otherwise → auto-scan: sort eligible cards by seq ascending
      const queue = readQueue(this.ctx.paths.pipelineOrderFile);
      const orderedSeqs: number[] = [];

      if (queue.length > 0) {
        // Queue-driven: use explicit order, only include cards that exist in Planning
        const eligibleSeqs = new Set(eligibleCards.map((c) => parseInt(c.seq, 10)));
        for (const seq of queue) {
          if (eligibleSeqs.has(seq)) orderedSeqs.push(seq);
        }
      } else {
        // Auto-scan: all eligible Planning cards sorted by seq
        const seqs = eligibleCards
          .map((c) => parseInt(c.seq, 10))
          .filter((n) => !isNaN(n))
          .sort((a, b) => a - b);
        orderedSeqs.push(...seqs);
      }

      if (orderedSeqs.length === 0) {
        this.log.info('No eligible cards in queue or Planning');
        result.details = { reason: 'no_eligible_card' };
        return result;
      }

      // 4. Walk ordered list and promote eligible cards
      //    Scheduler promotion (Planning → Backlog) is lightweight — it only
      //    changes card state in PM. The real throttle is in ExecutionEngine
      //    which launches actual workers. We allow promoting up to
      //    MAX_CONCURRENT_WORKERS cards per tick so the pipeline stays fed.
      let actionsThisTick = 0;
      const maxPromotions = this.ctx.config.MAX_CONCURRENT_WORKERS;

      for (const seq of orderedSeqs) {
        if (actionsThisTick >= maxPromotions) break;

        // Check admission rules
        const skipReason = this.checkAdmission(state);
        if (skipReason) {
          this.log.info(`Skipping: ${skipReason}`);
          result.details = { ...result.details, stoppedAt: skipReason };
          break;
        }

        const card = eligibleCards.find((c) => c.seq === String(seq));
        if (!card) continue;

        // Check conflict domain for this specific card
        const conflictBlock = this.checkConflictDomain(card, state);
        if (conflictBlock) {
          this.log.info(`seq ${seq} blocked by conflict: ${conflictBlock}`);
          actions.push({
            action: 'skip',
            entity: `seq:${seq}`,
            result: 'skip',
            message: conflictBlock,
          });
          continue;
        }

        // Admission passed — promote card
        if (opts.dryRun) {
          this.log.info(`[dry-run] Would move seq ${seq} to Backlog`);
          actions.push({
            action: 'promote',
            entity: `seq:${seq}`,
            result: 'ok',
            message: 'dry-run: would move Planning → Backlog',
          });
        } else {
          try {
            await this.taskBackend.move(card.seq, 'Backlog');
            removeFromQueue(this.ctx.paths.pipelineOrderFile, seq);
            this.log.ok(`Moved seq ${seq} Planning → Backlog`);
            if (this.notifier) {
              await this.notifier.send(`[${this.ctx.projectName}] ↔️ seq:${seq} "${card.name}" scheduled (Planning → Backlog)`).catch(() => {});
            }
            this.log.event({
              component: 'scheduler',
              action: 'promote',
              entity: `seq:${seq}`,
              result: 'ok',
            });
            actions.push({
              action: 'promote',
              entity: `seq:${seq}`,
              result: 'ok',
              message: 'Moved Planning → Backlog',
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.error(`Failed to move seq ${seq}: ${msg}`);
            this.log.event({
              component: 'scheduler',
              action: 'promote',
              entity: `seq:${seq}`,
              result: 'fail',
              meta: { error: msg },
            });
            actions.push({
              action: 'promote',
              entity: `seq:${seq}`,
              result: 'fail',
              message: msg,
            });
            result.status = 'fail';
            result.exitCode = 1;
          }
        }
        actionsThisTick++;
      }

      if (actionsThisTick === 0 && result.status === 'ok') {
        result.details = { ...result.details, reason: 'no_eligible_card' };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Scheduler tick failed: ${msg}`);
      result.status = 'fail';
      result.exitCode = 1;
      result.details = { error: msg };
    }

    return result;
  }

  /**
   * Check global admission rules.
   * Returns null if admission passes, or a reason string if blocked.
   */
  private checkAdmission(
    state: import('../core/state.js').RuntimeState,
  ): string | null {
    const hasIdleSlot = Object.values(state.workers).some((w) => w.status === 'idle');
    if (!hasIdleSlot) return 'no_idle_slot';
    return null;
  }

  /**
   * Check conflict domain constraints for a specific card.
   *
   * Only Inprogress cards are considered as blocking — QA and Done cards
   * are about to be released and should not prevent new cards from entering
   * the pipeline. This avoids the stall where a card in QA (waiting for
   * CI/merge) blocks the next card from being scheduled.
   */
  private checkConflictDomain(
    card: Card,
    state: import('../core/state.js').RuntimeState,
  ): string | null {
    // Only consider cards that are actively being worked on (have a worker assigned)
    const inprogressCards = Object.values(state.activeCards).filter(
      (ac) => ac.state === 'Inprogress' || ac.state === 'Todo',
    );
    if (inprogressCards.length === 0) return null;

    const cardDomains = card.labels
      .filter((l) => l.startsWith('conflict:'))
      .map((l) => l.slice('conflict:'.length));

    if (cardDomains.length === 0) {
      if (this.ctx.config.CONFLICT_DEFAULT === 'serial') {
        return 'serial_default_blocked';
      }
      return null;
    }

    for (const active of inprogressCards) {
      for (const domain of cardDomains) {
        if (active.conflictDomains.includes(domain)) {
          return `conflict_domain_collision:${domain}:seq:${active.seq}`;
        }
      }
    }

    return null;
  }
}
