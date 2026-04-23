import { useEffect } from 'react';

export function ConfirmDialog({
  title,
  body,
  confirm,
  onConfirm,
  onCancel,
  danger,
}: {
  title: string;
  body: string;
  confirm: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  danger?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/30"
    >
      <div className="nb-card max-w-md w-full">
        <h2 id="confirm-title" className="font-[family-name:var(--font-heading)] text-xl font-bold mb-2">
          {title}
        </h2>
        <p className="text-sm text-[var(--color-text-muted)] mb-5">{body}</p>
        <div className="flex gap-3 justify-end">
          <button className="nb-btn" onClick={onCancel} type="button">
            取消
          </button>
          <button
            className={danger ? 'nb-btn nb-btn-danger' : 'nb-btn nb-btn-yellow'}
            onClick={async () => { await onConfirm(); }}
            type="button"
          >
            {confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
