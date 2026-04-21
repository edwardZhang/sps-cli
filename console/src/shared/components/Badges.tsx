/**
 * Skill / Label 徽章 —— Pastel Neubrutalism 风。
 * SkillBadge 按类别映射颜色。LabelBadge 按工作流标签语义。
 */

const LANGUAGES = new Set([
  'python', 'typescript', 'golang', 'rust', 'kotlin', 'swift', 'java',
]);
const ENDS = new Set(['frontend', 'backend', 'mobile', 'database', 'devops']);
const PERSONAS = new Set([
  'backend-architect', 'frontend-developer', 'code-reviewer', 'database-optimizer',
  'devops-automator', 'security-engineer', 'qa-tester', 'security', 'qa', 'architect', 'db-opt',
]);
const WORKFLOWS = new Set([
  'coding-standards', 'tdd-workflow', 'git-workflow',
  'architecture-decision-records', 'debugging-workflow',
]);

type Variant = 'lang' | 'end' | 'persona' | 'workflow' | 'other';

function classify(name: string): Variant {
  if (LANGUAGES.has(name)) return 'lang';
  if (ENDS.has(name)) return 'end';
  if (PERSONAS.has(name)) return 'persona';
  if (WORKFLOWS.has(name)) return 'workflow';
  return 'other';
}

const VARIANT_BG: Record<Variant, string> = {
  lang:     'var(--color-accent-purple)',
  end:      'var(--color-secondary)',
  persona:  'var(--color-primary)',
  workflow: 'var(--color-accent-mint)',
  other:    'var(--color-bg)',
};

export function SkillBadge({ name }: { name: string }) {
  const bg = VARIANT_BG[classify(name)];
  return (
    <span className="nb-badge" style={{ background: bg }}>
      {name}
    </span>
  );
}

type LabelKind = 'default' | 'warn' | 'accent';

export function LabelBadge({ label, kind = 'default' }: { label: string; kind?: LabelKind }) {
  const bg =
    kind === 'warn'
      ? 'var(--color-accent-pink)'
      : kind === 'accent'
        ? 'var(--color-accent-yellow)'
        : 'var(--color-bg-cream)';
  return (
    <span className="nb-badge" style={{ background: bg }}>
      {label}
    </span>
  );
}
