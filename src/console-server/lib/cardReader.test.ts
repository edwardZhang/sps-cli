/**
 * cardReader tests —— 重点验证 v0.49.5 修的子目录扫描 bug。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { listCards, readCard } from './cardReader.js';

function makeCard(seq: number, title: string): string {
  return `---
seq: ${seq}
title: ${title}
labels:
  - AI-PIPELINE
skills:
  - frontend
created: 2026-04-22T00:00:00Z
---

## 描述

Test card body.

## 检查清单

- [ ] a
- [x] b
`;
}

describe('cardReader', () => {
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = mkdtempSync(resolve(tmpdir(), 'sps-card-test-'));
  });

  afterEach(() => {
    rmSync(tmpProject, { recursive: true, force: true });
  });

  it('listCards 读取 cards/<state>/ 子目录里的卡片', () => {
    const cardsDir = resolve(tmpProject, 'cards');
    mkdirSync(resolve(cardsDir, 'planning'), { recursive: true });
    mkdirSync(resolve(cardsDir, 'inprogress'), { recursive: true });
    mkdirSync(resolve(cardsDir, 'done'), { recursive: true });
    writeFileSync(resolve(cardsDir, 'planning', '1-todo-task.md'), makeCard(1, 'todo task'));
    writeFileSync(resolve(cardsDir, 'inprogress', '2-running.md'), makeCard(2, 'running'));
    writeFileSync(resolve(cardsDir, 'done', '3-finished.md'), makeCard(3, 'finished'));

    const cards = listCards(tmpProject);
    expect(cards).toHaveLength(3);
    // 按 seq 倒序
    expect(cards.map((c) => c.seq)).toEqual([3, 2, 1]);
    // state 来自物理目录名，normalize 过
    const byState = Object.fromEntries(cards.map((c) => [c.seq, c.state]));
    expect(byState).toEqual({ 1: 'Planning', 2: 'Inprogress', 3: 'Done' });
  });

  it('listCards 返回空数组当 cards/ 不存在', () => {
    expect(listCards(tmpProject)).toEqual([]);
  });

  it('listCards 跳过非数字开头的文件 + 非 md 文件', () => {
    const cardsDir = resolve(tmpProject, 'cards');
    mkdirSync(resolve(cardsDir, 'planning'), { recursive: true });
    writeFileSync(resolve(cardsDir, 'planning', '1-valid.md'), makeCard(1, 'valid'));
    writeFileSync(resolve(cardsDir, 'planning', 'readme.md'), '# not a card\n'); // no leading digit
    writeFileSync(resolve(cardsDir, 'planning', '2-note.txt'), 'not md');
    writeFileSync(resolve(cardsDir, 'planning', '.DS_Store'), 'junk');

    const cards = listCards(tmpProject);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.seq).toBe(1);
  });

  it('listCards state normalization：大小写目录都映射到 canonical', () => {
    const cardsDir = resolve(tmpProject, 'cards');
    mkdirSync(resolve(cardsDir, 'QA'), { recursive: true });
    mkdirSync(resolve(cardsDir, 'qa'), { recursive: true });
    writeFileSync(resolve(cardsDir, 'QA', '1-a.md'), makeCard(1, 'a'));
    writeFileSync(resolve(cardsDir, 'qa', '2-b.md'), makeCard(2, 'b'));

    const cards = listCards(tmpProject);
    expect(cards).toHaveLength(2);
    // 两个都应该 normalize 成 'QA'
    expect(cards.every((c) => c.state === 'QA')).toBe(true);
  });

  it('listCards 兼容顶层 md（老格式）', () => {
    const cardsDir = resolve(tmpProject, 'cards');
    mkdirSync(cardsDir, { recursive: true });
    writeFileSync(resolve(cardsDir, '1-top-level.md'), makeCard(1, 'top level'));

    const cards = listCards(tmpProject);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.seq).toBe(1);
    // 顶层文件没目录信息，state 默认 Backlog
    expect(cards[0]?.state).toBe('Backlog');
  });

  it('readCard 从子目录里定位卡片', () => {
    const cardsDir = resolve(tmpProject, 'cards');
    mkdirSync(resolve(cardsDir, 'planning'), { recursive: true });
    writeFileSync(resolve(cardsDir, 'planning', '42-deep.md'), makeCard(42, 'deep card'));

    const card = readCard(tmpProject, 42);
    expect(card).not.toBeNull();
    expect(card?.title).toBe('deep card');
    expect(card?.state).toBe('Planning');
    // checklist 解析
    expect(card?.checklist.total).toBe(2);
    expect(card?.checklist.done).toBe(1);
  });

  it('readCard 返回 null 当 seq 不存在', () => {
    const cardsDir = resolve(tmpProject, 'cards');
    mkdirSync(resolve(cardsDir, 'backlog'), { recursive: true });
    expect(readCard(tmpProject, 999)).toBeNull();
  });
});
