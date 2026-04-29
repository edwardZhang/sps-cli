import { useEffect, useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';

/**
 * 新建 pipeline 对话框（v0.49.3）：文件名 + 模板三选一。
 * 替代原来的 prompt() 简单文本输入。
 */
export function NewPipelineDialog({
  onCancel,
  onCreate,
  hasActive,
  hasSample,
  isPending,
}: {
  onCancel: () => void;
  onCreate: (name: string, template: 'blank' | 'sample' | 'active') => void;
  hasActive: boolean;
  hasSample: boolean;
  isPending: boolean;
}) {
  const [name, setName] = useState('');
  const [template, setTemplate] = useState<'blank' | 'sample' | 'active'>('blank');

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const filename = name.trim();
  const normalizedFilename = filename.endsWith('.yaml') ? filename : filename ? `${filename}.yaml` : '';
  const valid = normalizedFilename && /^[a-zA-Z0-9_.-]+\.yaml$/.test(normalizedFilename);

  const submit = (): void => {
    if (!valid || isPending) return;
    onCreate(normalizedFilename, template);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/30"
    >
      <div className="nb-card max-w-md w-full">
        <header className="flex items-start justify-between mb-4">
          <h2 className="font-[family-name:var(--font-heading)] text-xl font-bold">
            New pipeline
          </h2>
          <button
            className="nb-btn nb-btn-mint p-2"
            onClick={onCancel}
            type="button"
            aria-label="Close"
          >
            <X size={14} strokeWidth={3} />
          </button>
        </header>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex flex-col gap-4"
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-bold">Filename</span>
            <input
              type="text"
              className="nb-input w-full font-[family-name:var(--font-mono)]"
              placeholder="e.g. ci"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            <span className="text-xs text-[var(--color-text-muted)]">
              Saved as <code className="font-[family-name:var(--font-mono)]">{normalizedFilename || 'xxx.yaml'}</code>。
              Allowed: a-z A-Z 0-9 _ -. A duplicate name returns 409.
            </span>
          </label>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-bold mb-1">Initial contents</legend>

            <TemplateOption
              value="blank"
              current={template}
              label="Blank template"
              desc="Minimal 1-stage pipeline (develop → Done)"
              onSelect={setTemplate}
            />
            <TemplateOption
              value="sample"
              current={template}
              label="Tutorial template"
              desc="Copy from sample.yaml.example (commented, explains every field)"
              onSelect={setTemplate}
              disabled={!hasSample}
              disabledReason="sample.yaml.example not found"
            />
            <TemplateOption
              value="active"
              current={template}
              label="Copy from current"
              desc="Copy from project.yaml (start from the current config)"
              onSelect={setTemplate}
              disabled={!hasActive}
              disabledReason="project.yaml not found"
            />
          </fieldset>

          <div className="flex gap-3 justify-end pt-2">
            <button
              className="nb-btn"
              onClick={onCancel}
              type="button"
              disabled={isPending}
            >
              Cancel
            </button>
            <button
              className="nb-btn nb-btn-primary"
              type="submit"
              disabled={!valid || isPending}
              aria-label="Create pipeline"
            >
              {isPending ? (
                <Loader2 size={13} strokeWidth={3} className="animate-spin" />
              ) : (
                <Plus size={13} strokeWidth={3} />
              )}
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function TemplateOption({
  value,
  current,
  label,
  desc,
  onSelect,
  disabled,
  disabledReason,
}: {
  value: 'blank' | 'sample' | 'active';
  current: string;
  label: string;
  desc: string;
  onSelect: (v: 'blank' | 'sample' | 'active') => void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const selected = current === value;
  return (
    <label
      className={[
        'flex items-start gap-2 p-2 rounded-lg border-2 cursor-pointer',
        disabled
          ? 'border-[var(--color-border-light)] opacity-50 cursor-not-allowed'
          : selected
            ? 'bg-[var(--color-accent-mint)] border-[var(--color-text)] shadow-[2px_2px_0_var(--color-text)]'
            : 'border-[var(--color-border-light)] hover:bg-[var(--color-bg-cream)] hover:border-[var(--color-text)]',
      ].join(' ')}
    >
      <input
        type="radio"
        name="pipeline-template"
        value={value}
        checked={selected}
        disabled={disabled}
        onChange={() => onSelect(value)}
        className="mt-1 flex-shrink-0"
      />
      <div className="flex-1">
        <div className="text-sm font-bold">{label}</div>
        <div className="text-xs text-[var(--color-text-muted)]">
          {disabled ? disabledReason : desc}
        </div>
      </div>
    </label>
  );
}
