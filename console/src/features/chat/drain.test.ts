/**
 * Drain loop pure logic test.
 *
 * The ChatPage drain loop is inline React state, but the math is pure:
 *   given blocks with (target, displayed), advance displayed toward target
 *   with step = max(1, ceil(totalGap/40)).
 *
 * Mirror that math here and assert the convergence property, so refactors
 * don't accidentally break streaming animation.
 */
import { describe, it, expect } from 'vitest';

type Block =
  | { type: 'text'; target: string; displayed: string }
  | { type: 'tool_use' };

function drainStep(blocks: Block[]): Block[] {
  const totalGap = blocks.reduce(
    (sum, b) => (b.type === 'text' ? sum + (b.target.length - b.displayed.length) : sum),
    0,
  );
  if (totalGap <= 0) return blocks;
  let remaining = Math.max(1, Math.ceil(totalGap / 40));
  return blocks.map((b) => {
    if (b.type !== 'text' || remaining <= 0) return b;
    const gap = b.target.length - b.displayed.length;
    if (gap <= 0) return b;
    const step = Math.min(gap, remaining);
    remaining -= step;
    return { ...b, displayed: b.target.slice(0, b.displayed.length + step) };
  });
}

describe('chat drain loop math', () => {
  it('advances displayed toward target by ceil(gap/40) each tick', () => {
    const blocks: Block[] = [{ type: 'text', target: 'a'.repeat(800), displayed: '' }];
    let state = blocks;
    // After one tick, step = ceil(800/40) = 20
    state = drainStep(state);
    expect((state[0] as { displayed: string }).displayed.length).toBe(20);
    // Subsequent ticks keep advancing with recomputed gap
    state = drainStep(state);
    // gap = 780, step = ceil(780/40) = 20 → displayed = 40
    expect((state[0] as { displayed: string }).displayed.length).toBe(40);
  });

  it('minimum step is 1 even when gap is 1', () => {
    const blocks: Block[] = [{ type: 'text', target: 'a', displayed: '' }];
    const state = drainStep(blocks);
    expect((state[0] as { displayed: string }).displayed).toBe('a');
  });

  it('no advance when all text blocks are caught up', () => {
    const blocks: Block[] = [
      { type: 'text', target: 'done', displayed: 'done' },
      { type: 'tool_use' },
    ];
    const state = drainStep(blocks);
    expect(state).toEqual(blocks);
  });

  it('distributes remaining budget across multiple text blocks in order', () => {
    // Two text blocks with equal gaps → step budget splits across them
    const blocks: Block[] = [
      { type: 'text', target: 'x'.repeat(400), displayed: 'x'.repeat(200) },
      { type: 'tool_use' },
      { type: 'text', target: 'y'.repeat(400), displayed: 'y'.repeat(200) },
    ];
    // totalGap = 400, step = 10
    const state = drainStep(blocks);
    const b0 = state[0] as { displayed: string };
    const b2 = state[2] as { displayed: string };
    // First block absorbs all 10 (it's the earliest with gap)
    expect(b0.displayed.length).toBe(210);
    expect(b2.displayed.length).toBe(200);
  });

  it('converges in bounded ticks (gap shrinks by ~1/40 per tick)', () => {
    // With ceil(gap/40), gap decays ~(39/40)^N. For target=500:
    //   needs ~log(500)/log(40/39) ≈ 250 ticks for full convergence.
    // Use 500 char target and give 600 tick budget — plenty of headroom.
    let state: Block[] = [{ type: 'text', target: 'z'.repeat(500), displayed: '' }];
    let converged = -1;
    for (let i = 0; i < 600; i++) {
      state = drainStep(state);
      const b = state[0] as { displayed: string };
      if (b.displayed.length === 500) {
        converged = i + 1;
        break;
      }
    }
    expect(converged).toBeGreaterThan(0);
    expect(converged).toBeLessThan(600);
  });
});
