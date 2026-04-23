/**
 * @module        features/workers/components/shared/StateBadge
 * @description   Worker state → neo-brutalist 标签
 */
import { Loader2, Skull } from 'lucide-react';
import type { WorkerState } from '../../../../shared/api/workers';

export function StateBadge({ state }: { state: WorkerState }) {
  const config: Record<
    WorkerState,
    { bg: string; color: string; label: string; icon?: React.ReactNode }
  > = {
    running: { bg: 'var(--color-running-bg)', color: 'var(--color-running)', label: 'running' },
    starting: {
      bg: 'var(--color-secondary)',
      color: 'var(--color-text)',
      label: 'starting',
      icon: <Loader2 size={9} strokeWidth={3} className="animate-spin" />,
    },
    stuck: { bg: 'var(--color-stuck-bg)', color: 'var(--color-stuck)', label: 'stuck' },
    crashed: {
      bg: 'var(--color-crashed-bg)',
      color: 'var(--color-crashed)',
      label: 'crashed',
      icon: <Skull size={9} strokeWidth={2.5} />,
    },
    idle: { bg: 'var(--color-idle-bg)', color: 'var(--color-idle)', label: 'idle' },
  };
  const c = config[state];
  return (
    <span
      className="nb-status inline-flex items-center gap-1"
      style={{ background: c.bg, color: c.color }}
    >
      {c.icon}
      {c.label}
    </span>
  );
}
