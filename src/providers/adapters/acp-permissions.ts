/**
 * ACP Permission Resolver — aligned with OpenClaw/acpx permissions.ts
 *
 * 3-layer decision chain:
 *   1. Global policy (approve-all / deny-all)
 *   2. Kind classification (approve-reads auto-approves read/search)
 *   3. Unattended fallback (SPS auto-approves everything — no TTY)
 */

export type PermissionMode = 'approve-all' | 'approve-reads' | 'deny-all';

interface PermissionParams {
  toolCall: {
    toolCallId?: string;
    title?: string;
    kind?: string;
    status?: string;
  };
  options: ReadonlyArray<{
    optionId: string;
    kind: string;
    name?: string;
  }>;
}

interface PermissionResponse {
  outcome:
    | { outcome: 'selected'; optionId: string }
    | { outcome: 'cancelled' };
}

function pickOption(
  options: PermissionParams['options'],
  kinds: readonly string[],
): PermissionParams['options'][number] | undefined {
  for (const kind of kinds) {
    const match = options.find((o) => o.kind === kind);
    if (match) return match;
  }
  return undefined;
}

/** Infer tool kind from toolCall.kind or title keywords (aligned with acpx). */
export function inferToolKind(params: Pick<PermissionParams, 'toolCall'>): string | undefined {
  if (params.toolCall.kind) return params.toolCall.kind;
  const title = params.toolCall.title?.trim().toLowerCase() ?? '';
  const head = title.split(':', 1)[0]?.trim() ?? '';
  if (!head) return undefined;
  if (head.includes('read') || head.includes('cat')) return 'read';
  if (head.includes('search') || head.includes('find') || head.includes('grep')) return 'search';
  if (head.includes('write') || head.includes('edit') || head.includes('patch')) return 'edit';
  if (head.includes('delete') || head.includes('remove')) return 'delete';
  if (head.includes('move') || head.includes('rename')) return 'move';
  if (head.includes('run') || head.includes('execute') || head.includes('bash')) return 'execute';
  if (head.includes('fetch') || head.includes('http') || head.includes('url')) return 'fetch';
  if (head.includes('think')) return 'think';
  return 'other';
}

export function resolvePermission(params: PermissionParams, mode: PermissionMode): PermissionResponse {
  const { options } = params;
  if (options.length === 0) return { outcome: { outcome: 'cancelled' } };

  const allowOption = pickOption(options, ['allow_once', 'allow_always']);
  const rejectOption = pickOption(options, ['reject_once', 'reject_always']);

  // Layer 1: global policy
  if (mode === 'approve-all') {
    return { outcome: { outcome: 'selected', optionId: allowOption?.optionId ?? options[0].optionId } };
  }
  if (mode === 'deny-all') {
    return rejectOption
      ? { outcome: { outcome: 'selected', optionId: rejectOption.optionId } }
      : { outcome: { outcome: 'cancelled' } };
  }

  // Layer 2: approve-reads — auto-approve read/search kinds
  const kind = inferToolKind(params);
  if ((kind === 'read' || kind === 'search') && allowOption) {
    return { outcome: { outcome: 'selected', optionId: allowOption.optionId } };
  }

  // Layer 3: SPS is unattended — auto-approve (no TTY interaction)
  if (allowOption) {
    return { outcome: { outcome: 'selected', optionId: allowOption.optionId } };
  }
  return { outcome: { outcome: 'cancelled' } };
}
