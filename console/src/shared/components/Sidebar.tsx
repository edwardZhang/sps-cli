import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  MessageSquare,
  LayoutGrid,
  Kanban,
  Users,
  FileText,
  Globe,
  Settings,
} from 'lucide-react';

const NAV_ITEMS = [
  { to: '/chat', key: 'chat', icon: MessageSquare },
  { to: '/projects', key: 'projects', icon: LayoutGrid },
  { to: '/board', key: 'board', icon: Kanban },
  { to: '/workers', key: 'workers', icon: Users },
  { to: '/logs', key: 'logs', icon: FileText },
  { to: '/skills', key: 'skills', icon: Globe },
  { to: '/system', key: 'system', icon: Settings },
] as const;

export function Sidebar() {
  const { t } = useTranslation('common');
  return (
    <>
      <div className="font-[family-name:var(--font-heading)] font-bold text-lg px-3 pt-2 pb-4 flex items-center gap-3 text-[var(--color-text)]">
        <span className="w-5 h-5 rounded-md bg-[var(--color-accent-mint)] border-2 border-[var(--color-text)] shadow-[2px_2px_0_var(--color-text)]" />
        SPS Console
      </div>
      <nav className="flex flex-col gap-1.5 mt-2" aria-label={t('nav.chat')}>
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
              {t(`nav.${item.key}`)}
            </NavLink>
          );
        })}
      </nav>
    </>
  );
}
