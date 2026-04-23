/**
 * @module        TaskBackend
 * @description   任务后端接口，定义卡片 CRUD、状态流转、标签及元数据操作的契约
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-19
 * @updated       2026-03-27
 *
 * @role          interface
 * @layer         interface
 * @boundedContext task-management
 */

import type { Card, CardState } from '../shared/types.js';

export interface TaskBackend {
  listAll(): Promise<Card[]>;
  listByState(state: CardState): Promise<Card[]>;
  getBySeq(seq: string): Promise<Card | null>;
  move(seq: string, targetState: CardState): Promise<void>;
  addLabel(seq: string, label: string): Promise<void>;
  removeLabel(seq: string, label: string): Promise<void>;
  claim(seq: string, workerSlot: string): Promise<void>;
  releaseClaim(seq: string): Promise<void>;
  comment(seq: string, text: string): Promise<void>;
  create(title: string, desc: string, state: CardState): Promise<Card>;
  /** v0.42.0+: set the `skills` frontmatter field on a card (replaces any existing value). */
  setSkills(seq: string, skills: string[]): Promise<void>;
  /** v0.49.7+: update title + rename file. */
  setTitle(seq: string, title: string): Promise<void>;
  /** v0.49.7+: replace body's "## 描述" section. */
  setDescription(seq: string, desc: string): Promise<void>;
  /** v0.49.7+: replace entire labels array (dedupe + drop empty). */
  setLabels(seq: string, labels: string[]): Promise<void>;
  /** v0.49.13+: delete the card md file. */
  delete(seq: string): Promise<void>;
  checklistCreate(seq: string, items: string[]): Promise<void>;
  checklistList(seq: string): Promise<{ id: string; text: string; checked: boolean }[]>;
  checklistCheck(seq: string, itemId: string): Promise<void>;
  checklistUncheck(seq: string, itemId: string): Promise<void>;
  metaRead(seq: string): Promise<Record<string, unknown>>;
  metaWrite(seq: string, data: Record<string, unknown>): Promise<void>;
  incrementRetryCount(seq: string): Promise<number>;
  resetRetryCount(seq: string): Promise<void>;
  bootstrap(): Promise<void>;
}
