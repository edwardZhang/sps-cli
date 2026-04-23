/**
 * @module        services/ports
 * @description   Service 层抽象依赖端口 —— concrete 实现在 services/defaults.ts
 *
 * @layer         services
 *
 * 为什么不直接 import Domain 具体类：
 *   - 单测能用 fake 替换
 *   - delivery 层不会被迫加载整个 Domain 图
 *   - 将来想换 TaskBackend 实现（gitlab/github backend）只改 factory
 */
import type { TaskBackend } from '../interfaces/TaskBackend.js';

/** 按 project 名拿 TaskBackend 实例 */
export interface TaskBackendFactory {
  for(project: string): Promise<TaskBackend>;
}
