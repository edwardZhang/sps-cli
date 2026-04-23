/**
 * @module        shared/types
 * @description   跨层共享的领域类型 —— Service / Domain / Infra 都能 import
 *
 * @layer         shared
 *
 * 迁移策略：Phase 1 以 re-export 方式建立新入口 models/types.ts 保持不动。
 * Phase 3 全量迁移 caller 后再物理迁入本文件并删除 models/types.ts。
 * 这样旧代码不受影响，新代码统一从 shared/types import。
 */
export type {
  ActionRecord,
  AuxiliaryState,
  Card,
  CardState,
  ChecklistItem,
  ChecklistStats,
  CheckResult,
  CommandResult,
  MrStatus,
  RecommendedAction,
  StepResult,
  TickResult,
  WorkerStatus,
} from '../models/types.js';
