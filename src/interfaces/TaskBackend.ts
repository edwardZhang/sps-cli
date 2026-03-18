import type { Card, CardState } from '../models/types.js';

export interface TaskBackend {
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
