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

import type { Card, CardState } from '../models/types.js';

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
  create(name: string, desc: string, state: CardState): Promise<Card>;
  checklistCreate(seq: string, items: string[]): Promise<void>;
  checklistList(seq: string): Promise<{ id: string; text: string; checked: boolean }[]>;
  checklistCheck(seq: string, itemId: string): Promise<void>;
  checklistUncheck(seq: string, itemId: string): Promise<void>;
  metaRead(seq: string): Promise<Record<string, unknown>>;
  metaWrite(seq: string, data: Record<string, unknown>): Promise<void>;
  bootstrap(): Promise<void>;
}
