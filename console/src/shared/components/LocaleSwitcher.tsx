import { useTranslation } from 'react-i18next';
import { Globe } from 'lucide-react';
import { SUPPORTED_LOCALES, type Locale } from '../../i18n';

/**
 * Compact EN / 中文 toggle. Persists choice to localStorage via the i18next
 * language detector ('sps.locale' key).
 */
export function LocaleSwitcher() {
  const { i18n, t } = useTranslation('common');
  const current = (i18n.resolvedLanguage ?? 'en') as Locale;

  return (
    <div
      className="inline-flex items-center gap-1.5 border-2 border-[var(--color-text)] rounded-full bg-[var(--color-bg-cream)] p-1"
      role="group"
      aria-label={t('locale.label')}
    >
      <Globe size={12} strokeWidth={2.5} className="ml-1.5 mr-0.5 text-[var(--color-text-muted)]" />
      {SUPPORTED_LOCALES.map((loc) => {
        const active = current === loc;
        return (
          <button
            key={loc}
            type="button"
            onClick={() => {
              if (!active) void i18n.changeLanguage(loc);
            }}
            className={[
              'text-xs font-bold px-2 py-0.5 rounded-full transition-colors',
              active
                ? 'bg-[var(--color-accent-mint)] border-2 border-[var(--color-text)] shadow-[1px_1px_0_var(--color-text)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
            ].join(' ')}
            aria-pressed={active}
          >
            {t(`locale.${loc}`)}
          </button>
        );
      })}
    </div>
  );
}
