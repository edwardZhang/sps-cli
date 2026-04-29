import { Link } from 'react-router-dom';

export function NotFound() {
  return (
    <div className="nb-card max-w-2xl mt-12">
      <h1 className="font-[family-name:var(--font-heading)] text-4xl font-bold mb-2">
        404 · Page not found
      </h1>
      <p className="text-[var(--color-text-muted)] mb-6">
        Could not find this page. The link may have expired.
      </p>
      <Link to="/" className="nb-btn nb-btn-mint inline-flex">
        Back to home
      </Link>
    </div>
  );
}
