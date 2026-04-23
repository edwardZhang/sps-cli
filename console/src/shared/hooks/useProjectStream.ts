import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

/**
 * 订阅 /stream/projects/:name SSE。
 * 事件进来 → 失效对应 TanStack Query cache，让页面自动 refetch。
 */
export function useProjectStream(project: string | null | undefined): void {
  const qc = useQueryClient();

  useEffect(() => {
    if (!project) return;
    const url = `/stream/projects/${encodeURIComponent(project)}`;
    const es = new EventSource(url);

    const onCardChange = (ev: MessageEvent): void => {
      try {
        const data = JSON.parse(ev.data) as { project: string; seq: number };
        qc.invalidateQueries({ queryKey: ['cards', data.project] });
        // v0.50.7：不再把事件里的 partial Card 塞进 ['card', p, seq] 缓存 ——
        // 事件的 card 是 CardSummary 形，没有 body / 完整 checklist.items。塞进去
        // 会让 CardDetailModal 显示残缺数据，直到下一轮真 refetch 才补全。
        // 改为失效缓存，强制 useQuery 发真请求。
        qc.invalidateQueries({ queryKey: ['card', data.project, data.seq] });
        qc.invalidateQueries({ queryKey: ['projects'] });
      } catch {
        /* ignore */
      }
    };
    const onWorkerChange = (ev: MessageEvent): void => {
      try {
        const data = JSON.parse(ev.data) as { project: string };
        qc.invalidateQueries({ queryKey: ['workers', data.project] });
        qc.invalidateQueries({ queryKey: ['projects'] });
      } catch {
        /* ignore */
      }
    };
    const onPipelineStatus = (ev: MessageEvent): void => {
      try {
        const data = JSON.parse(ev.data) as { project: string };
        qc.invalidateQueries({ queryKey: ['pipeline-status', data.project] });
        qc.invalidateQueries({ queryKey: ['projects'] });
      } catch {
        /* ignore */
      }
    };

    es.addEventListener('card.created', onCardChange);
    es.addEventListener('card.updated', onCardChange);
    es.addEventListener('card.moved', onCardChange);
    es.addEventListener('card.deleted', onCardChange);
    es.addEventListener('worker.updated', onWorkerChange);
    es.addEventListener('worker.added', onWorkerChange);
    es.addEventListener('worker.deleted', onWorkerChange);
    // v0.50.6：后端 DomainEvent 是 pipeline.started / pipeline.stopped，
    // 不是老名字 pipeline.status。两种都挂一下，避免再踩 bus 名漂移。
    es.addEventListener('pipeline.status', onPipelineStatus);
    es.addEventListener('pipeline.started', onPipelineStatus);
    es.addEventListener('pipeline.stopped', onPipelineStatus);

    return () => es.close();
  }, [project, qc]);
}
