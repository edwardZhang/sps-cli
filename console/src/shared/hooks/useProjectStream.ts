import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Card } from '../api/cards';

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
        const data = JSON.parse(ev.data) as { project: string; seq: number; card?: Card };
        qc.invalidateQueries({ queryKey: ['cards', data.project] });
        if (data.card) {
          qc.setQueryData(['card', data.project, data.seq], {
            ...(qc.getQueryData(['card', data.project, data.seq]) ?? {}),
            ...data.card,
          });
        }
        // project list 聚合数字也变
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
    es.addEventListener('card.deleted', onCardChange);
    es.addEventListener('worker.updated', onWorkerChange);
    es.addEventListener('worker.added', onWorkerChange);
    es.addEventListener('worker.deleted', onWorkerChange);
    es.addEventListener('pipeline.status', onPipelineStatus);

    return () => es.close();
  }, [project, qc]);
}
