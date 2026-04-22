import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Loader2, Plus } from 'lucide-react';
import { createProject, type CreateProjectInput } from '../../shared/api/projects';
import { useDialog } from '../../shared/components/DialogProvider';

/**
 * /projects/new — create-project wizard, single form page.
 *
 * 字段对齐 `sps project init` 非交互入参：
 *   name (required) / projectDir (required) / mergeBranch / maxWorkers
 *   gitlabProject (optional) / gitlabProjectId (optional) / matrixRoomId (optional)
 */
export function NewProjectPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { alert } = useDialog();

  const [form, setForm] = useState<CreateProjectInput>({
    name: '',
    projectDir: '',
    mergeBranch: 'main',
    maxWorkers: '1',
  });

  const mutation = useMutation({
    mutationFn: (input: CreateProjectInput) => createProject(input),
    onSuccess: (project) => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      nav(`/projects/${encodeURIComponent(project.name)}`);
    },
    onError: (err) => {
      void alert({
        title: '创建失败',
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
          aria-label="返回项目列表"
        >
          <ArrowLeft size={14} strokeWidth={3} />
          返回
        </button>
        <h1 className="font-[family-name:var(--font-heading)] text-3xl font-bold">
          新建项目
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
            label="项目名"
            hint="只能用字母、数字、下划线、连字符。例如 acme-web"
          >
            <input
              type="text"
              className="nb-input w-full font-[family-name:var(--font-mono)]"
              placeholder="例如: acme-web"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              autoFocus
              required
            />
            {form.name && !nameValid && (
              <p className="text-xs text-[var(--color-crashed)] mt-1">
                名称只能包含 a-z A-Z 0-9 _ -
              </p>
            )}
          </Field>

          <Field label="Git 仓库路径" hint="本机绝对路径，如 /home/coral/code/acme">
            <input
              type="text"
              className="nb-input w-full font-[family-name:var(--font-mono)]"
              placeholder="/home/coral/code/acme"
              value={form.projectDir}
              onChange={(e) => setForm({ ...form, projectDir: e.target.value })}
              required
            />
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="合并分支">
              <input
                type="text"
                className="nb-input w-full font-[family-name:var(--font-mono)]"
                value={form.mergeBranch}
                onChange={(e) => setForm({ ...form, mergeBranch: e.target.value })}
              />
            </Field>
            <Field label="最大 Worker 数">
              <input
                type="number"
                min="1"
                max="8"
                className="nb-input w-full font-[family-name:var(--font-mono)]"
                value={form.maxWorkers}
                onChange={(e) => setForm({ ...form, maxWorkers: e.target.value })}
              />
            </Field>
          </div>

          <div className="pt-2 border-t-2 border-[var(--color-text)] border-dashed">
            <h3 className="font-[family-name:var(--font-heading)] text-sm font-bold uppercase tracking-wider mb-3 text-[var(--color-text-muted)]">
              可选配置
            </h3>
            <div className="flex flex-col gap-4">
              <Field label="Git 远程项目路径" hint="如 user/repo，空则跳过 Git API">
                <input
                  type="text"
                  className="nb-input w-full font-[family-name:var(--font-mono)]"
                  placeholder="user/repo"
                  value={form.gitlabProject ?? ''}
                  onChange={(e) => setForm({ ...form, gitlabProject: e.target.value })}
                />
              </Field>
              {form.gitlabProject && (
                <Field label="GitLab 项目 ID" hint="数字，GitHub 用户可留空">
                  <input
                    type="text"
                    className="nb-input w-full font-[family-name:var(--font-mono)]"
                    placeholder="42"
                    value={form.gitlabProjectId ?? ''}
                    onChange={(e) => setForm({ ...form, gitlabProjectId: e.target.value })}
                  />
                </Field>
              )}
              <Field label="Matrix 房间 ID" hint="空则使用全局配置">
                <input
                  type="text"
                  className="nb-input w-full font-[family-name:var(--font-mono)]"
                  placeholder="!abc:matrix.example.com"
                  value={form.matrixRoomId ?? ''}
                  onChange={(e) => setForm({ ...form, matrixRoomId: e.target.value })}
                />
              </Field>
            </div>
          </div>

          <div className="flex gap-3 justify-end pt-3">
            <button
              type="button"
              className="nb-btn"
              onClick={() => nav('/projects')}
              disabled={mutation.isPending}
            >
              取消
            </button>
            <button
              type="submit"
              className="nb-btn nb-btn-primary"
              disabled={!canSubmit}
              aria-label="创建项目"
            >
              {mutation.isPending ? (
                <>
                  <Loader2 size={14} strokeWidth={3} className="animate-spin" />
                  创建中…
                </>
              ) : (
                <>
                  <Plus size={14} strokeWidth={3} />
                  创建
                </>
              )}
            </button>
          </div>
        </form>
      </div>
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
