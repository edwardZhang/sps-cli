import { NavLink } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  MessageSquare,
  LayoutGrid,
  Kanban,
  Users,
  FileText,
  Globe,
  Settings,
} from 'lucide-react';
import { getSystemInfo } from '../api/system';

const NAV_ITEMS = [
  { to: '/chat', label: '对话', icon: MessageSquare },
  { to: '/projects', label: '项目', icon: LayoutGrid },
  { to: '/board', label: '看板', icon: Kanban },
  { to: '/workers', label: 'Workers', icon: Users },
  { to: '/logs', label: 'Logs', icon: FileText },
  { to: '/skills', label: 'Skills', icon: Globe },
  { to: '/system', label: '系统', icon: Settings },
];

export function Sidebar() {
  // v0.50.14：Sidebar 版本号走 /api/system/info，不再硬编码。
  const infoQ = useQuery({
    queryKey: ['system-info'],
    queryFn: getSystemInfo,
    staleTime: 60_000,
  });
  return (
    <>
      <div className="font-[family-name:var(--font-heading)] font-bold text-lg px-3 pt-2 pb-4 flex items-center gap-3 text-[var(--color-text)]">
        <span className="w-5 h-5 rounded-md bg-[var(--color-accent-mint)] border-2 border-[var(--color-text)] shadow-[2px_2px_0_var(--color-text)]" />
        SPS Console
        <span className="text-xs text-[var(--color-text-muted)] font-[family-name:var(--font-mono)] font-normal">
          {infoQ.data ? `v${infoQ.data.version}` : '…'}
        </span>
      </div>
      <nav className="flex flex-col gap-1.5 mt-2" aria-label="主导航">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                [
                  'flex items-center gap-3 px-3 py-2.5 rounded-xl font-semibold text-sm cursor-pointer transition-transform duration-150',
                  'border-2 border-transparent',
                  isActive
                    ? 'bg-[var(--color-accent-mint)] border-[var(--color-text)] shadow-[3px_3px_0_var(--color-text)] font-bold'
                    : 'text-[var(--color-text)] hover:bg-[var(--color-bg-cream)] hover:border-[var(--color-text)] hover:shadow-[3px_3px_0_var(--color-text)] hover:-translate-x-px hover:-translate-y-px',
                ].join(' ')
              }
            >
              <Icon size={18} strokeWidth={2.5} />
              {item.label}
            </NavLink>
          );
        })}
      </nav>
    </>
  );
}
