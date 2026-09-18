import type { Message } from './vendor/fast-jev/types.js';

export const VERBATIM_HEADER = [
  '# Retained history (verbatim)',
  '',
  'This is not a written summary. The messages below are the original',
  'conversation, unchanged and in order. Only tool calls and tool results that',
  'the Jev decision model judged no longer needed were dropped or truncated;',
  'any tool can be re-run if its output is needed again.',
].join('\n');

function renderInput(input: Record<string, unknown>): string {
  const json = JSON.stringify(input);
  if (json === undefined) return '{}';
  return json.length > 2000 ? `${json.slice(0, 2000)}… (input truncated)` : json;
}

/**
 * Serializes the kept transcript back to text for omp's compaction summary.
 *
 * omp's `session_before_compact` contract accepts a summary string, not a
 * rewritten message list, so verbatim retention is expressed by making the
 * summary *be* the surviving conversation.
 */
export function renderVerbatim(messages: readonly Message[]): string {
  const blocks: string[] = [VERBATIM_HEADER];

  for (const message of messages) {
    const parts: string[] = [];
    const label = message.role === 'assistant' ? 'Assistant' : 'User';
    if (message.text.trim()) parts.push(`## ${label}\n\n${message.text}`);
    else if (message.toolUses.length === 0 && (message.toolResults?.length ?? 0) === 0) continue;
    else parts.push(`## ${label}`);

    for (const use of message.toolUses) {
      parts.push(`### Tool call: ${use.tool} (${use.tool_use_id})\n\n\`\`\`json\n${renderInput(use.input)}\n\`\`\``);
    }
    for (const result of message.toolResults ?? []) {
      const tag = result.isError ? 'error' : 'result';
      parts.push(`### Tool ${tag} (${result.tool_use_id})\n\n${result.text}`);
    }
    blocks.push(parts.join('\n\n'));
  }

  return blocks.join('\n\n');
}

/** Characters in a transcript, for the reduction check. */
export function transcriptChars(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += message.text.length;
    for (const use of message.toolUses) total += use.tool.length + JSON.stringify(use.input ?? {}).length;
    for (const result of message.toolResults ?? []) total += result.text.length;
  }
  return total;
}
