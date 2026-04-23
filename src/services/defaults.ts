/**
 * @module        services/defaults
 * @description   Service port 的默认 production 实现（glue layer，绑 Domain 具体类）
 *
 * @layer         services
 *
 * 本文件是 Service 层允许"伸入"Domain concrete 类的地方 —— 所有 new MarkdownTaskBackend /
 * ProjectContext.load 集中在这，其它 service 文件禁止直接 import 具体实现。
 */
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import type { TaskBackendFactory } from './ports.js';

export class DefaultTaskBackendFactory implements TaskBackendFactory {
  async for(project: string): Promise<TaskBackend> {
    const { ProjectContext } = await import('../core/context.js');
    const { createTaskBackend } = await import('../providers/registry.js');
    const ctx = ProjectContext.load(project);
    const backend = createTaskBackend(ctx.config);
    await backend.bootstrap();
    return backend;
  }
}
