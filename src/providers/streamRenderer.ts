/**
 * Transforms raw stream-json/JSONL output into human-readable dashboard text.
 */

/**
 * Render Claude stream-json lines into readable output for the dashboard.
 * Each input line is a JSON object from --output-format stream-json.
 */
export function renderClaudeStreamLines(rawLines: string[]): string[] {
  const output: string[] = [];

  for (const line of rawLines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const rendered = renderClaudeEvent(obj);
      if (rendered) output.push(rendered);
    } catch {
      // Not valid JSON — show as-is (might be stderr mixed in)
      if (line.trim()) output.push(line);
    }
  }

  return output;
}

function renderClaudeEvent(obj: Record<string, unknown>): string | null {
  switch (obj.type) {
    case 'system':
      return null; // skip system messages

    case 'assistant': {
      const msg = obj.message as Record<string, unknown> | undefined;
      if (msg && typeof msg.content === 'string') {
        return truncate(msg.content, 120);
      }
      return null;
    }

    case 'tool_use': {
      const name = obj.name || 'Tool';
      const input = obj.input as Record<string, unknown> | undefined;
      let detail = '';
      if (input) {
        if (typeof input.command === 'string') detail = ` ${truncate(input.command, 80)}`;
        else if (typeof input.pattern === 'string') detail = ` ${input.pattern}`;
        else if (typeof input.file_path === 'string') detail = ` ${input.file_path}`;
      }
      return `[${name}]${detail}`;
    }

    case 'tool_result':
      return null; // too verbose for dashboard

    case 'result': {
      const cost = typeof obj.total_cost_usd === 'number'
        ? ` ($${obj.total_cost_usd.toFixed(2)})`
        : '';
      const reason = obj.subtype === 'success' ? 'Done' : `Exit: ${obj.subtype}`;
      return `✓ ${reason}${cost}`;
    }

    default:
      return null;
  }
}

/**
 * Render Codex exec --json JSONL lines into readable output.
 */
export function renderCodexStreamLines(rawLines: string[]): string[] {
  const output: string[] = [];

  for (const line of rawLines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const rendered = renderCodexEvent(obj);
      if (rendered) output.push(rendered);
    } catch {
      if (line.trim()) output.push(line);
    }
  }

  return output;
}

function renderCodexEvent(obj: Record<string, unknown>): string | null {
  const type = obj.type as string;

  if (type === 'message' && typeof obj.content === 'string') {
    return truncate(obj.content, 120);
  }

  if (type === 'function_call' || type === 'tool_call') {
    const name = (obj.name || obj.function || 'Tool') as string;
    return `[${name}]`;
  }

  if (type === 'completed' || type === 'done') {
    return '✓ Done';
  }

  return null;
}

function truncate(s: string, maxLen: number): string {
  const oneLine = s.replace(/\n/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 1) + '…';
}
