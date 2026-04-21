/**
 * @module        checklist.test
 * @description   parseChecklist unit tests (v0.42.0+)
 */
import { describe, expect, it } from 'vitest';
import { parseChecklist } from './checklist.js';

describe('parseChecklist', () => {
  it('returns undefined when no ## 检查清单 section exists', () => {
    const body = '## 描述\n\n任务描述\n\n## 日志\n';
    expect(parseChecklist(body)).toBeUndefined();
  });

  it('returns empty stats when section exists but no items', () => {
    const body = '## 检查清单\n\n\n## 日志\n';
    expect(parseChecklist(body)).toEqual({ total: 0, done: 0, percent: 0, items: [] });
  });

  it('counts all unchecked items as 0%', () => {
    const body = '## 检查清单\n- [ ] 子任务 1\n- [ ] 子任务 2\n- [ ] 子任务 3\n\n## 日志\n';
    const stats = parseChecklist(body);
    expect(stats?.total).toBe(3);
    expect(stats?.done).toBe(0);
    expect(stats?.percent).toBe(0);
  });

  it('counts all checked items as 100%', () => {
    const body = '## 检查清单\n- [x] 完成 1\n- [x] 完成 2\n\n## 日志\n';
    const stats = parseChecklist(body);
    expect(stats?.total).toBe(2);
    expect(stats?.done).toBe(2);
    expect(stats?.percent).toBe(100);
  });

  it('computes correct percentage for mixed items', () => {
    const body = '## 检查清单\n- [x] a\n- [x] b\n- [ ] c\n- [ ] d\n- [ ] e\n\n## 日志\n';
    const stats = parseChecklist(body);
    expect(stats?.total).toBe(5);
    expect(stats?.done).toBe(2);
    expect(stats?.percent).toBe(40);  // 2/5 = 40%
  });

  it('treats uppercase [X] as done', () => {
    const body = '## 检查清单\n- [X] capital\n\n## 日志\n';
    expect(parseChecklist(body)?.done).toBe(1);
  });

  it('ignores nested sub-items (only top-level counted)', () => {
    const body = `## 检查清单
- [x] 前端
  - [x] form
  - [ ] validation
- [ ] 后端

## 日志
`;
    const stats = parseChecklist(body);
    expect(stats?.total).toBe(2);   // "前端" + "后端", not the nested ones
    expect(stats?.done).toBe(1);    // only "前端" is checked at top level
  });

  it('stops parsing at next ## heading', () => {
    const body = '## 检查清单\n- [x] a\n- [ ] b\n\n## 日志\n- [x] log item (should not count)\n';
    const stats = parseChecklist(body);
    expect(stats?.total).toBe(2);
  });

  it('recognizes English "Checklist" heading alias', () => {
    const body = '## Checklist\n- [x] done\n- [ ] todo\n\n## Logs\n';
    const stats = parseChecklist(body);
    expect(stats?.total).toBe(2);
    expect(stats?.done).toBe(1);
  });

  it('preserves item text in items array', () => {
    const body = '## 检查清单\n- [x] 前端 form 实现\n- [ ] 后端 API\n';
    const stats = parseChecklist(body);
    expect(stats?.items).toEqual([
      { text: '前端 form 实现', done: true },
      { text: '后端 API', done: false },
    ]);
  });
});
