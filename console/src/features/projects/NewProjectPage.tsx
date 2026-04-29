import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FolderOpen, Loader2, Plus } from 'lucide-react';
import { createProject, type CreateProjectInput } from '../../shared/api/projects';
import { DirectoryPicker } from '../../shared/components/DirectoryPicker';
import { useDialog } from '../../shared/components/DialogProvider';

/**
 * /projects/new — 新建项目表单
 *
 * v0.50.24：
 *   - Git 支持开关（默认 ON）—— OFF 时隐藏合并分支和远程路径
 *   - "Git 仓库路径" → "项目目录"（本机绝对路径，和是否 git 无关）
 *   - ACK 超时分钟数加入配置（默认 5 分钟）
 */
export function NewProjectPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { alert } = useDialog();

  const [form, setForm] = useState<CreateProjectInput>({
    name: '',
    projectDir: '',
    enableGit: true,
    // v0.51.6: 默认 true — 用户填了路径就是要在那里建项目；
    // 不存在时自动 mkdir -p 后再装 .claude/ 与 wiki/。
    createIfMissing: true,
    mergeBranch: 'main',
    maxWorkers: '1',
    ackTimeoutMin: '5',
  });

  const [pickerOpen, setPickerOpen] = useState(false);

  const mutation = useMutation({
    mutationFn: (input: CreateProjectInput) => createProject(input),
    onSuccess: (project) => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      nav(`/projects/${encodeURIComponent(project.name)}`);
    },
    onError: (err) => {
      void alert({
        title: 'Create failed',
        body: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const nameValid = /^[a-zA-Z0-9_-]+$/.test(form.name);
  const canSubmit = nameValid && form.projectDir.trim() !== '' && !mutation.isPending;

  return (
    <div className="flex flex-col gap-5 max-w-2xl">
      <header className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => nav('/projects')}
          className="nb-btn"
          style={{ padding: '6px 12px' }}
          aria-label="Back to projects"
        >
          <ArrowLeft size={14} strokeWidth={3} />
          Back
        </button>
        <h1 className="font-[family-name:var(--font-heading)] text-3xl font-bold">
          New project
        </h1>
      </header>

      <div className="nb-card">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSubmit) return;
            mutation.mutate(form);
          }}
          className="flex flex-col gap-5"
        >
          <Field
            label="Project name"
            hint="Letters, digits, _ and - only. e.g. acme-web"
          >
            <input
              type="text"
              className="nb-input w-full font-[family-name:var(--font-mono)]"
              placeholder="e.g. acme-web"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              autoFocus
              required
            />
            {form.name && !nameValid && (
              <p className="text-xs text-[var(--color-crashed)] mt-1">
                Name may only contain a-z A-Z 0-9 _ -
              </p>
            )}
          </Field>

          <Field label="Project directory" hint="Absolute path on this machine (code or docs are both fine). Independent of the git toggle.">
            <div className="flex gap-2">
              <input
                type="text"
                className="nb-input flex-1 font-[family-name:var(--font-mono)]"
                placeholder="/home/coral/code/acme"
                value={form.projectDir}
                onChange={(e) => setForm({ ...form, projectDir: e.target.value })}
                required
              />
              <button
                type="button"
                className="nb-btn flex-shrink-0"
                onClick={() => setPickerOpen(true)}
                aria-label="Browse for project directory"
                title="Browse for project directory"
              >
                <FolderOpen size={14} strokeWidth={2.5} />
                Browse
              </button>
            </div>
            <label className="flex items-center gap-2 mt-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={form.createIfMissing !== false}
                onChange={(e) => setForm({ ...form, createIfMissing: e.target.checked })}
                className="w-4 h-4 cursor-pointer"
              />
              <span className="text-xs text-[var(--color-text-muted)]">
                Auto-create the directory if missing (recommended — otherwise .claude/ and wiki/ install are skipped)
              </span>
            </label>
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Max workers">
              <input
                type="number"
                min="1"
                max="8"
                className="nb-input w-full font-[family-name:var(--font-mono)]"
                value={form.maxWorkers}
                onChange={(e) => setForm({ ...form, maxWorkers: e.target.value })}
              />
            </Field>
            <Field label="ACK timeout (minutes)" hint="How long after launch with no ACK before the worker is treated as failed">
              <input
                type="number"
                min="1"
                max="30"
                className="nb-input w-full font-[family-name:var(--font-mono)]"
                value={form.ackTimeoutMin ?? '5'}
                onChange={(e) => setForm({ ...form, ackTimeoutMin: e.target.value })}
              />
            </Field>
          </div>

          {/* Git 开关 + 相关字段 */}
          <div className="pt-3 border-t-2 border-[var(--color-text)] border-dashed">
            <label className="flex items-center gap-3 mb-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={form.enableGit ?? true}
                onChange={(e) => setForm({ ...form, enableGit: e.target.checked })}
                className="w-4 h-4 cursor-pointer"
              />
              <span className="text-sm font-bold">Enable Git (Worker auto-commits + pushes)</span>
            </label>
            <p className="text-xs text-[var(--color-text-muted)] mb-3">
              When off, the Worker just runs the task without version control; good for docs/data projects.
            </p>

            {form.enableGit !== false && (
              <div className="flex flex-col gap-4 bg-[var(--color-bg-cream)] border-2 border-[var(--color-text)] rounded-lg p-4">
                <Field label="Merge branch">
                  <input
                    type="text"
                    className="nb-input w-full font-[family-name:var(--font-mono)]"
                    value={form.mergeBranch ?? 'main'}
                    onChange={(e) => setForm({ ...form, mergeBranch: e.target.value })}
                  />
                </Field>
                <Field label="Git remote project path" hint="e.g. user/repo. Empty skips the remote API (local commit/push only).">
                  <input
                    type="text"
                    className="nb-input w-full font-[family-name:var(--font-mono)]"
                    placeholder="user/repo"
                    value={form.gitlabProject ?? ''}
                    onChange={(e) => setForm({ ...form, gitlabProject: e.target.value })}
                  />
                </Field>
                {form.gitlabProject && (
                  <Field label="GitLab project ID" hint="numeric; GitHub users leave empty">
                    <input
                      type="text"
                      className="nb-input w-full font-[family-name:var(--font-mono)]"
                      placeholder="42"
                      value={form.gitlabProjectId ?? ''}
                      onChange={(e) => setForm({ ...form, gitlabProjectId: e.target.value })}
                    />
                  </Field>
                )}
              </div>
            )}
          </div>

          {/* Wiki 知识库开关 (v0.51.0) */}
          <div className="pt-3 border-t-2 border-[var(--color-text)] border-dashed">
            <label className="flex items-center gap-3 mb-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={form.enableWiki === true}
                onChange={(e) => setForm({ ...form, enableWiki: e.target.checked })}
                className="w-4 h-4 cursor-pointer"
              />
              <span className="text-sm font-bold">Enable Wiki knowledge base (per-project)</span>
            </label>
            <p className="text-xs text-[var(--color-text-muted)]">
              Scaffolds <code className="font-mono">wiki/</code> dir and injects 5-layer retrieval context plus wiki-update hints into Worker prompts. You can also enable later with <code className="font-mono">sps wiki init</code> .
            </p>
          </div>

          {/* 通知 */}
          <div className="pt-3 border-t-2 border-[var(--color-text)] border-dashed">
            <h3 className="font-[family-name:var(--font-heading)] text-sm font-bold uppercase tracking-wider mb-3 text-[var(--color-text-muted)]">
              Notifications
            </h3>
            <Field label="Matrix room ID" hint="empty = use global config; blank = no notifications">
              <input
                type="text"
                className="nb-input w-full font-[family-name:var(--font-mono)]"
                placeholder="!abc:matrix.example.com"
                value={form.matrixRoomId ?? ''}
                onChange={(e) => setForm({ ...form, matrixRoomId: e.target.value })}
              />
            </Field>
          </div>

          <div className="flex gap-3 justify-end pt-3">
            <button
              type="button"
              className="nb-btn"
              onClick={() => nav('/projects')}
              disabled={mutation.isPending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="nb-btn nb-btn-primary"
              disabled={!canSubmit}
              aria-label="Create project"
            >
              {mutation.isPending ? (
                <>
                  <Loader2 size={14} strokeWidth={3} className="animate-spin" />
                  Creating…
                </>
              ) : (
                <>
                  <Plus size={14} strokeWidth={3} />
                  Create
                </>
              )}
            </button>
          </div>
        </form>
      </div>

      {pickerOpen && (
        <DirectoryPicker
          title="Select project directory"
          initialPath={form.projectDir.trim() || undefined}
          onCancel={() => setPickerOpen(false)}
          onSelect={(picked) => {
            setForm({ ...form, projectDir: picked });
            setPickerOpen(false);
          }}
        />
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-bold">{label}</span>
      {children}
      {hint && <span className="text-xs text-[var(--color-text-muted)]">{hint}</span>}
    </label>
  );
}
