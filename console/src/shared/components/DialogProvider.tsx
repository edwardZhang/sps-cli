import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * Promise-based dialog API replacing window.confirm / window.alert / window.prompt.
 *
 *   const { confirm, alert, prompt } = useDialog();
 *   if (!(await confirm({ title: '删除吗？', body: '...' , danger: true }))) return;
 *   await alert({ title: '出错了', body: err.message });
 *   const title = await prompt({ title: '新建卡片', placeholder: '卡片标题' });
 *
 * 只允许一个 dialog 同时展示（和原生行为一致）。Escape 关；prompt 内 Enter 提交。
 */

type ConfirmOpts = {
  title: string;
  body: string;
  confirm?: string;
  cancel?: string;
  danger?: boolean;
};

type AlertOpts = {
  title: string;
  body: string;
  confirm?: string;
};

type PromptOpts = {
  title: string;
  body?: string;
  placeholder?: string;
  defaultValue?: string;
  confirm?: string;
  cancel?: string;
};

type DialogState =
  | { kind: 'confirm'; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { kind: 'alert'; opts: AlertOpts; resolve: () => void }
  | { kind: 'prompt'; opts: PromptOpts; resolve: (v: string | null) => void };

interface DialogApi {
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
  alert: (opts: AlertOpts) => Promise<void>;
  prompt: (opts: PromptOpts) => Promise<string | null>;
}

const DialogCtx = createContext<DialogApi | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialogState | null>(null);

  const confirm = useCallback(
    (opts: ConfirmOpts): Promise<boolean> =>
      new Promise((resolve) => {
        setState({
          kind: 'confirm',
          opts,
          resolve: (v) => {
            setState(null);
            resolve(v);
          },
        });
      }),
    [],
  );

  const alert = useCallback(
    (opts: AlertOpts): Promise<void> =>
      new Promise((resolve) => {
        setState({
          kind: 'alert',
          opts,
          resolve: () => {
            setState(null);
            resolve();
          },
        });
      }),
    [],
  );

  const prompt = useCallback(
    (opts: PromptOpts): Promise<string | null> =>
      new Promise((resolve) => {
        setState({
          kind: 'prompt',
          opts,
          resolve: (v) => {
            setState(null);
            resolve(v);
          },
        });
      }),
    [],
  );

  const { t } = useTranslation('common');
  return (
    <DialogCtx.Provider value={{ confirm, alert, prompt }}>
      {children}
      {state?.kind === 'confirm' && (
        <ConfirmDialog
          title={state.opts.title}
          body={state.opts.body}
          confirm={state.opts.confirm ?? t('actions.ok')}
          danger={state.opts.danger}
          onConfirm={() => state.resolve(true)}
          onCancel={() => state.resolve(false)}
        />
      )}
      {state?.kind === 'alert' && (
        <AlertDialog
          title={state.opts.title}
          body={state.opts.body}
          confirm={state.opts.confirm ?? t('actions.ok')}
          onClose={() => state.resolve()}
        />
      )}
      {state?.kind === 'prompt' && (
        <PromptDialog
          title={state.opts.title}
          body={state.opts.body}
          placeholder={state.opts.placeholder}
          defaultValue={state.opts.defaultValue}
          confirm={state.opts.confirm ?? t('actions.ok')}
          cancel={state.opts.cancel ?? t('actions.cancel')}
          onConfirm={(v) => state.resolve(v)}
          onCancel={() => state.resolve(null)}
        />
      )}
    </DialogCtx.Provider>
  );
}

export function useDialog(): DialogApi {
  const ctx = useContext(DialogCtx);
  if (!ctx) throw new Error('useDialog must be used inside <DialogProvider>');
  return ctx;
}

function AlertDialog({
  title,
  body,
  confirm,
  onClose,
}: {
  title: string;
  body: string;
  confirm: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || e.key === 'Enter') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/30"
    >
      <div className="nb-card max-w-md w-full">
        <h2 className="font-[family-name:var(--font-heading)] text-xl font-bold mb-2">
          {title}
        </h2>
        <p className="text-sm text-[var(--color-text-muted)] mb-5 whitespace-pre-wrap break-words">
          {body}
        </p>
        <div className="flex gap-3 justify-end">
          <button className="nb-btn nb-btn-primary" onClick={onClose} type="button" autoFocus>
            {confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

function PromptDialog({
  title,
  body,
  placeholder,
  defaultValue,
  confirm,
  cancel,
  onConfirm,
  onCancel,
}: {
  title: string;
  body?: string;
  placeholder?: string;
  defaultValue?: string;
  confirm: string;
  cancel: string;
  onConfirm: (v: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(defaultValue ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const submit = (): void => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/30"
    >
      <div className="nb-card max-w-md w-full">
        <h2 className="font-[family-name:var(--font-heading)] text-xl font-bold mb-2">
          {title}
        </h2>
        {body && (
          <p className="text-sm text-[var(--color-text-muted)] mb-3 whitespace-pre-wrap break-words">
            {body}
          </p>
        )}
        <input
          ref={inputRef}
          type="text"
          className="nb-input w-full mb-5"
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="flex gap-3 justify-end">
          <button className="nb-btn" onClick={onCancel} type="button">
            {cancel}
          </button>
          <button
            className="nb-btn nb-btn-primary"
            onClick={submit}
            type="button"
            disabled={!value.trim()}
          >
            {confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
