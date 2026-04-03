import { ProjectContext } from '../core/context.js';
import { Logger } from '../core/logger.js';
import type { CardState } from '../models/types.js';
import { createTaskBackend } from '../providers/registry.js';

const VALID_STATES: CardState[] = ['Planning', 'Backlog', 'Todo', 'Inprogress', 'QA', 'Done'];

export async function executePmCommand(
  project: string,
  subcommand: string,
  positionals: string[],
  flags: Record<string, boolean>,
): Promise<void> {
  const log = new Logger('pm', project);
  const jsonOutput = !!flags.json;

  let ctx: ProjectContext;
  try {
    ctx = ProjectContext.load(project);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (jsonOutput) {
      console.log(JSON.stringify({ project, component: 'pm', status: 'fail', exitCode: 3, error: msg }));
    } else {
      log.error(`Fatal: ${msg}`);
    }
    process.exit(3);
  }

  const taskBackend = createTaskBackend(ctx.config);

  try {
    switch (subcommand) {
      case 'scan': {
        const state = (positionals[0] as CardState) || undefined;
        if (state && !VALID_STATES.includes(state)) {
          console.error(`Invalid state: ${state}. Valid: ${VALID_STATES.join(', ')}`);
          process.exit(2);
        }
        const states = state ? [state] : VALID_STATES;
        const allCards = [];
        for (const s of states) {
          const cards = await taskBackend.listByState(s);
          allCards.push(...cards);
        }
        if (jsonOutput) {
          console.log(JSON.stringify(allCards, null, 2));
        } else {
          for (const card of allCards) {
            const labels = card.labels.length > 0 ? ` [${card.labels.join(', ')}]` : '';
            console.log(`  ${card.seq.padStart(4)} | ${card.state.padEnd(11)} | ${card.name}${labels}`);
          }
          console.log(`\n  Total: ${allCards.length} card(s)`);
        }
        break;
      }

      case 'move': {
        const seq = positionals[0];
        const targetState = positionals[1] as CardState;
        if (!seq || !targetState) {
          console.error('Usage: sps pm move <project> <seq> <state>');
          process.exit(2);
        }
        if (!VALID_STATES.includes(targetState)) {
          console.error(`Invalid state: ${targetState}. Valid: ${VALID_STATES.join(', ')}`);
          process.exit(2);
        }
        await taskBackend.move(seq, targetState);
        if (jsonOutput) {
          console.log(JSON.stringify({ seq, targetState, status: 'ok' }));
        } else {
          log.ok(`Moved seq ${seq} → ${targetState}`);
        }
        break;
      }

      case 'comment': {
        const seq = positionals[0];
        const text = positionals.slice(1).join(' ');
        if (!seq || !text) {
          console.error('Usage: sps pm comment <project> <seq> <text>');
          process.exit(2);
        }
        await taskBackend.comment(seq, text);
        if (jsonOutput) {
          console.log(JSON.stringify({ seq, status: 'ok' }));
        } else {
          log.ok(`Comment added to seq ${seq}`);
        }
        break;
      }

      case 'checklist': {
        const action = positionals[0]; // create, list, check, uncheck
        const seq = positionals[1];
        if (!action || !seq) {
          console.error('Usage: sps pm checklist <create|list|check|uncheck> <project> <seq> [items...]');
          process.exit(2);
        }

        switch (action) {
          case 'create': {
            const items = positionals.slice(2);
            if (items.length === 0) {
              console.error('Usage: sps pm checklist create <project> <seq> <item1> <item2> ...');
              process.exit(2);
            }
            await taskBackend.checklistCreate(seq, items);
            log.ok(`Checklist created for seq ${seq} (${items.length} items)`);
            break;
          }
          case 'list': {
            const items = await taskBackend.checklistList(seq);
            if (jsonOutput) {
              console.log(JSON.stringify(items, null, 2));
            } else {
              for (const item of items) {
                const icon = item.checked ? '☑' : '☐';
                console.log(`  ${icon} [${item.id}] ${item.text}`);
              }
            }
            break;
          }
          case 'check': {
            const itemId = positionals[2];
            if (!itemId) { console.error('Usage: sps pm checklist check <project> <seq> <item-id>'); process.exit(2); }
            await taskBackend.checklistCheck(seq, itemId);
            log.ok(`Checked item ${itemId} on seq ${seq}`);
            break;
          }
          case 'uncheck': {
            const itemId = positionals[2];
            if (!itemId) { console.error('Usage: sps pm checklist uncheck <project> <seq> <item-id>'); process.exit(2); }
            await taskBackend.checklistUncheck(seq, itemId);
            log.ok(`Unchecked item ${itemId} on seq ${seq}`);
            break;
          }
          default:
            console.error(`Unknown checklist action: ${action}`);
            process.exit(2);
        }
        break;
      }

      case 'label': {
        const action = positionals[0]; // add, remove
        const seq = positionals[1];
        const label = positionals[2];
        if (!action || !seq || !label) {
          console.error('Usage: sps pm label <add|remove> <project> <seq> <label>');
          process.exit(2);
        }
        if (action === 'add') {
          await taskBackend.addLabel(seq, label);
          log.ok(`Added label "${label}" to seq ${seq}`);
        } else if (action === 'remove') {
          await taskBackend.removeLabel(seq, label);
          log.ok(`Removed label "${label}" from seq ${seq}`);
        } else {
          console.error(`Unknown label action: ${action}. Use: add, remove`);
          process.exit(2);
        }
        break;
      }

      default:
        console.error(`Unknown pm subcommand: ${subcommand}`);
        console.error('Available: scan, move, comment, checklist, label');
        process.exit(2);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (jsonOutput) {
      console.log(JSON.stringify({ project, component: 'pm', status: 'fail', error: msg }));
    } else {
      log.error(msg);
    }
    process.exit(1);
  }
}
