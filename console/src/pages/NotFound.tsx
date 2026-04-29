import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export function NotFound() {
  const { t } = useTranslation('common');
  return (
    <div className="nb-card max-w-2xl mt-12">
      <h1 className="font-[family-name:var(--font-heading)] text-4xl font-bold mb-2">
        {t('notFound.title')}
      </h1>
      <p className="text-[var(--color-text-muted)] mb-6">
        {t('notFound.body')}
      </p>
      <Link to="/" className="nb-btn nb-btn-mint inline-flex">
        {t('notFound.back')}
      </Link>
    </div>
  );
}
