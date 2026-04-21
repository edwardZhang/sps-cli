import { Link } from 'react-router-dom';

export function NotFound() {
  return (
    <div className="nb-card max-w-2xl mt-12">
      <h1 className="font-[family-name:var(--font-heading)] text-4xl font-bold mb-2">
        404 · 页面不存在
      </h1>
      <p className="text-[var(--color-text-muted)] mb-6">
        没找到这个页面。可能是链接过期了。
      </p>
      <Link to="/" className="nb-btn nb-btn-mint inline-flex">
        返回首页
      </Link>
    </div>
  );
}
