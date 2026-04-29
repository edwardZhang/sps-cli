import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import YAML from 'yaml';
import {
  X,
  Save,
  Loader2,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  AlertCircle,
  CheckCircle2,
  FileCode,
  FileText,
} from 'lucide-react';
import {
  getPipelineFile,
  updatePipelineFile,
  type ParsedPipeline,
  type PipelineStage,
} from '../../shared/api/projects';
import { useDialog } from '../../shared/components/DialogProvider';

/**
 * Pipeline 文件编辑器（v0.49.2 混合模式）。
 *
 * 两种编辑模式：
 *   - structured：stages 字段级表单 + 上/下排序 + 删除/添加
 *   - yaml：原始 textarea，高级用户可直接改
 *
 * 单 source of truth: `draft` (YAML string)。切换模式时即时 parse/serialize。
 */
export function PipelineEditor({
  projectName,
  file,
  onClose,
  onSaved,
}: {
  projectName: string;
  file: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const { alert } = useDialog();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['pipeline-file', projectName, file],
    queryFn: () => getPipelineFile(projectName, file),
  });

  const [mode, setMode] = useState<'structured' | 'yaml'>('structured');
  const [draft, setDraft] = useState<string | null>(null);
  const [etag, setEtag] = useState<string | null>(null);

  // 从 server 加载 → 初始化 draft
  useEffect(() => {
    if (data && draft === null) {
      setDraft(data.content);
      setEtag(data.etag);
      if (data.parseError) setMode('yaml'); // parse 失败的话直接进 YAML 模式
    }
  }, [data, draft]);

  // Escape 关
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const saveMutation = useMutation({
    mutationFn: () => {
      if (draft === null || etag === null) throw new Error('no draft');
      return updatePipelineFile(projectName, file, draft, etag);
    },
    onSuccess: (res) => {
      setEtag(res.etag);
      qc.invalidateQueries({ queryKey: ['pipeline-file', projectName, file] });
      qc.invalidateQueries({ queryKey: ['project-pipelines', projectName] });
      onSaved();
    },
    onError: (err) => {
      const status = (err as Error & { status?: number }).status;
      void alert({
        title:
          status === 409
            ? 'File was modified elsewhere'
            : status === 422
              ? 'Invalid YAML syntax'
              : 'Save failed',
        body: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const dirty = draft !== null && data && draft !== data.content;

  // 结构化模式下尝试解析；失败则切到 YAML
  const { parsed, parseError } = useMemo((): {
    parsed: ParsedPipeline | null;
    parseError: string | null;
  } => {
    if (draft === null) return { parsed: null, parseError: null };
    try {
      const p = YAML.parse(draft) as ParsedPipeline;
      return { parsed: p ?? {}, parseError: null };
    } catch (err) {
      return { parsed: null, parseError: err instanceof Error ? err.message : String(err) };
    }
  }, [draft]);

  const updateParsed = (next: ParsedPipeline): void => {
    try {
      const yaml = YAML.stringify(next, { lineWidth: 0 });
      setDraft(yaml);
    } catch (err) {
      void alert({
        title: 'YAML serialization failed',
        body: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-40 flex items-start justify-center p-6 bg-black/30 overflow-auto"
    >
      <div
        className="nb-card mt-8 w-full max-w-4xl flex flex-col"
        style={{ maxHeight: 'calc(100vh - 64px)' }}
      >
        {/* Header */}
        <header className="flex items-start justify-between gap-3 mb-3 flex-shrink-0">
          <div>
            <h2 className="font-[family-name:var(--font-heading)] text-2xl font-bold flex items-center gap-2">
              <FileCode size={20} strokeWidth={2.5} />
              <code className="font-[family-name:var(--font-mono)] text-lg">{file}</code>
              {data?.isActive && (
                <span
                  className="nb-status"
                  style={{
                    background: 'var(--color-running-bg)',
                    color: 'var(--color-running)',
                    padding: '2px 8px',
                  }}
                >
                  active
                </span>
              )}
            </h2>
            <p className="text-xs text-[var(--color-text-muted)] font-[family-name:var(--font-mono)] mt-1">
              {projectName}/pipelines/{file}
              {etag && ` · etag ${etag}`}
            </p>
          </div>
          <button
            className="nb-btn nb-btn-mint p-2"
            onClick={onClose}
            type="button"
            aria-label="Close"
          >
            <X size={14} strokeWidth={3} />
          </button>
        </header>

        {isLoading && <p className="text-[var(--color-text-muted)]">Loading…</p>}
        {isError && (
          <p className="text-[var(--color-crashed)]">
            Load failed: {error instanceof Error ? error.message : String(error)}
          </p>
        )}

        {data && draft !== null && (
          <>
            {/* 模式切换 + active warning */}
            <div className="flex items-center gap-3 mb-3 flex-shrink-0 flex-wrap">
              <div className="flex gap-1 p-1 bg-[var(--color-bg)] border-[2px] border-[var(--color-text)] rounded-full shadow-[2px_2px_0_var(--color-text)]">
                <button
                  type="button"
                  onClick={() => setMode('structured')}
                  aria-pressed={mode === 'structured'}
                  disabled={!!parseError}
                  className={[
                    'px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1.5',
                    mode === 'structured'
                      ? 'bg-[var(--color-primary)] text-[var(--color-text)] shadow-[1px_1px_0_var(--color-text)]'
                      : 'text-[var(--color-text-muted)]',
                    parseError ? 'opacity-50 cursor-not-allowed' : '',
                  ].join(' ')}
                  title={parseError ?? undefined}
                >
                  <FileText size={11} strokeWidth={2.5} />
                  Structured
                </button>
                <button
                  type="button"
                  onClick={() => setMode('yaml')}
                  aria-pressed={mode === 'yaml'}
                  className={[
                    'px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1.5',
                    mode === 'yaml'
                      ? 'bg-[var(--color-primary)] text-[var(--color-text)] shadow-[1px_1px_0_var(--color-text)]'
                      : 'text-[var(--color-text-muted)]',
                  ].join(' ')}
                >
                  <FileCode size={11} strokeWidth={2.5} />
                  Raw YAML
                </button>
              </div>
              {parseError && (
                <div className="flex items-center gap-1 text-xs text-[var(--color-crashed)] font-bold">
                  <AlertCircle size={12} strokeWidth={2.5} />
                  YAML parse: {parseError}
                </div>
              )}
              {data?.isActive && (
                <span className="text-xs text-[var(--color-stuck)] font-bold ml-auto">
                  ⚠ This is the active pipeline; takes effect on the next tick after save
                </span>
              )}
            </div>

            {/* Body */}
            <div className="flex-1 overflow-auto">
              {mode === 'structured' && parsed && (
                <StructuredEditor
                  parsed={parsed}
                  onChange={updateParsed}
                />
              )}
              {mode === 'yaml' && (
                <textarea
                  className="nb-input w-full font-[family-name:var(--font-mono)] text-xs"
                  style={{ minHeight: 400, resize: 'vertical' }}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  spellCheck={false}
                  aria-label="Pipeline YAML editor"
                />
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between mt-3 pt-3 border-t-2 border-dashed border-[var(--color-text)] flex-shrink-0">
              <span className="text-xs text-[var(--color-text-muted)]">
                {dirty ? (
                  <span className="text-[var(--color-stuck)] font-bold">● unsaved</span>
                ) : saveMutation.isSuccess ? (
                  <span className="text-[var(--color-running)] font-bold flex items-center gap-1">
                    <CheckCircle2 size={12} strokeWidth={2.5} /> Saved
                  </span>
                ) : (
                  'No changes'
                )}
              </span>
              <div className="flex gap-2">
                <button
                  className="nb-btn"
                  style={{ padding: '6px 14px' }}
                  onClick={() => {
                    setDraft(null);
                    refetch();
                  }}
                  disabled={saveMutation.isPending}
                  type="button"
                >
                  Reload
                </button>
                <button
                  className="nb-btn nb-btn-primary"
                  style={{ padding: '6px 14px' }}
                  onClick={() => saveMutation.mutate()}
                  disabled={!dirty || saveMutation.isPending}
                  type="button"
                  aria-label="Save pipeline"
                >
                  {saveMutation.isPending ? (
                    <Loader2 size={13} strokeWidth={3} className="animate-spin" />
                  ) : (
                    <Save size={13} strokeWidth={3} />
                  )}
                  Save
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── 结构化表单 ────────────────────────────────────────────────────────

function StructuredEditor({
  parsed,
  onChange,
}: {
  parsed: ParsedPipeline;
  onChange: (next: ParsedPipeline) => void;
}) {
  const stages = parsed.stages ?? [];

  const setStages = (next: PipelineStage[]): void => {
    onChange({ ...parsed, stages: next });
  };

  const addStage = (): void => {
    setStages([
      ...stages,
      { name: `stage-${stages.length + 1}`, on_complete: 'move_card Done' },
    ]);
  };

  const removeStage = (idx: number): void => {
    setStages(stages.filter((_, i) => i !== idx));
  };

  const moveStage = (idx: number, delta: -1 | 1): void => {
    const next = [...stages];
    const swap = idx + delta;
    if (swap < 0 || swap >= next.length) return;
    [next[idx], next[swap]] = [next[swap]!, next[idx]!];
    setStages(next);
  };

  const updateStage = (idx: number, patch: Partial<PipelineStage>): void => {
    setStages(stages.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Top: mode */}
      <div className="flex items-center gap-3 p-3 bg-[var(--color-bg-cream)] border-2 border-[var(--color-text)] rounded-lg">
        <label className="flex items-center gap-2 text-sm">
          <span className="font-bold">mode:</span>
          <select
            className="nb-input"
            style={{ padding: '4px 10px', fontSize: 12 }}
            value={parsed.mode ?? 'project'}
            onChange={(e) =>
              onChange({ ...parsed, mode: e.target.value as 'project' | 'steps' })
            }
          >
            <option value="project">project</option>
            <option value="steps">steps</option>
          </select>
        </label>
        <span className="text-xs text-[var(--color-text-muted)]">
          project = event-driven pipeline (default) · steps = sequential script
        </span>
      </div>

      {/* Stages */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-[family-name:var(--font-heading)] text-sm font-bold uppercase tracking-wider">
            Stages ({stages.length})
          </h3>
          <button
            type="button"
            className="nb-btn nb-btn-mint"
            style={{ padding: '4px 12px', fontSize: 12 }}
            onClick={addStage}
            aria-label="Add stage"
          >
            <Plus size={11} strokeWidth={3} /> Add stage
          </button>
        </div>
        {stages.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)] italic p-4 border-2 border-dashed border-[var(--color-text)] rounded-lg text-center">
            No stages yet. Click "Add stage" to start.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {stages.map((stage, idx) => (
              <StageCard
                key={idx}
                stage={stage}
                index={idx}
                total={stages.length}
                onChange={(patch) => updateStage(idx, patch)}
                onRemove={() => removeStage(idx)}
                onMoveUp={() => moveStage(idx, -1)}
                onMoveDown={() => moveStage(idx, 1)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StageCard({
  stage,
  index,
  total,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  stage: PipelineStage;
  index: number;
  total: number;
  onChange: (patch: Partial<PipelineStage>) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const onFail = stage.on_fail ?? {};
  return (
    <div className="nb-card bg-[var(--color-bg-cream)] p-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="font-[family-name:var(--font-heading)] font-bold text-sm">
          Stage #{index + 1}
          {stage.name && (
            <code className="ml-2 text-xs font-[family-name:var(--font-mono)] bg-[var(--color-bg)] border-2 border-[var(--color-text)] px-2 py-0.5 rounded">
              {stage.name}
            </code>
          )}
        </h4>
        <div className="flex gap-1">
          <button
            type="button"
            className="nb-btn"
            style={{ padding: '3px 8px' }}
            onClick={onMoveUp}
            disabled={index === 0}
            aria-label="Move up"
          >
            <ChevronUp size={12} strokeWidth={3} />
          </button>
          <button
            type="button"
            className="nb-btn"
            style={{ padding: '3px 8px' }}
            onClick={onMoveDown}
            disabled={index === total - 1}
            aria-label="Move down"
          >
            <ChevronDown size={12} strokeWidth={3} />
          </button>
          <button
            type="button"
            className="nb-btn nb-btn-danger"
            style={{ padding: '3px 8px' }}
            onClick={onRemove}
            aria-label="Delete stage"
          >
            <Trash2 size={12} strokeWidth={3} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <StageField label="name" hint="unique stage name">
          <input
            type="text"
            className="nb-input w-full font-[family-name:var(--font-mono)] text-xs"
            value={stage.name ?? ''}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="develop"
          />
        </StageField>
        <StageField label="profile" hint="skill profile (optional)">
          <input
            type="text"
            className="nb-input w-full font-[family-name:var(--font-mono)] text-xs"
            value={stage.profile ?? ''}
            onChange={(e) => onChange({ profile: e.target.value || undefined })}
            placeholder="fullstack"
          />
        </StageField>
        <StageField label="card_state" hint="card state during this stage">
          <input
            type="text"
            className="nb-input w-full font-[family-name:var(--font-mono)] text-xs"
            value={stage.card_state ?? ''}
            onChange={(e) => onChange({ card_state: e.target.value || undefined })}
            placeholder="Inprogress"
          />
        </StageField>
        <StageField label="timeout" hint="optional, e.g. 30m 2h">
          <input
            type="text"
            className="nb-input w-full font-[family-name:var(--font-mono)] text-xs"
            value={stage.timeout ?? ''}
            onChange={(e) => onChange({ timeout: e.target.value || undefined })}
            placeholder="2h"
          />
        </StageField>
        <StageField label="trigger" hint="trigger condition (optional, defaults applied)">
          <input
            type="text"
            className="nb-input w-full font-[family-name:var(--font-mono)] text-xs"
            value={stage.trigger ?? ''}
            onChange={(e) => onChange({ trigger: e.target.value || undefined })}
            placeholder="card_enters 'Todo'"
          />
        </StageField>
        <StageField label="on_complete" hint="action on success">
          <input
            type="text"
            className="nb-input w-full font-[family-name:var(--font-mono)] text-xs"
            value={stage.on_complete ?? ''}
            onChange={(e) => onChange({ on_complete: e.target.value })}
            placeholder="move_card Done"
          />
        </StageField>
      </div>

      {/* on_fail */}
      <div className="mt-4 pt-3 border-t-2 border-dashed border-[var(--color-text)]">
        <h5 className="text-xs font-bold uppercase tracking-wider mb-2 text-[var(--color-text-muted)]">
          on_fail
        </h5>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <StageField label="action" hint="action on failure, e.g. label NEEDS-FIX">
            <input
              type="text"
              className="nb-input w-full font-[family-name:var(--font-mono)] text-xs"
              value={onFail.action ?? ''}
              onChange={(e) =>
                onChange({ on_fail: { ...onFail, action: e.target.value || undefined } })
              }
              placeholder="label NEEDS-FIX"
            />
          </StageField>
          <StageField label="comment" hint="comment written into the card">
            <input
              type="text"
              className="nb-input w-full font-[family-name:var(--font-mono)] text-xs"
              value={onFail.comment ?? ''}
              onChange={(e) =>
                onChange({ on_fail: { ...onFail, comment: e.target.value || undefined } })
              }
              placeholder="Worker failed. Check logs."
            />
          </StageField>
        </div>
        <label className="flex items-center gap-2 mt-3 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={onFail.halt ?? true}
            onChange={(e) => onChange({ on_fail: { ...onFail, halt: e.target.checked } })}
          />
          <span className="font-bold">halt</span>
          <span className="text-xs text-[var(--color-text-muted)]">
            (stops the pipeline on failure; remove to continue with the next card)
          </span>
        </label>
      </div>
    </div>
  );
}

function StageField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-bold font-[family-name:var(--font-mono)]">
        {label}
      </span>
      {children}
      {hint && <span className="text-[10px] text-[var(--color-text-muted)]">{hint}</span>}
    </label>
  );
}
