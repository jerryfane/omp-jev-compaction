import type { Message, ToolResult, ToolUse } from './vendor/fast-jev/types.js';

/**
 * The parts of omp's `AgentMessage` this hook reads. Declared structurally so
 * the package does not have to compile against omp's internals; omp's real
 * messages satisfy it (`packages/ai/src/types.ts`).
 */
export interface OmpTextContent {
  type: 'text';
  text: string;
}
/**
 * omp's assistant tool-call part (`packages/ai/src/types.ts`): `id`, `name`
 * and `arguments`, not the `toolCallId`/`toolName`/`args` naming used on the
 * separate `toolResult` message.
 */
export interface OmpToolCall {
  type: 'toolCall';
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

/** Any other content part (thinking, images, provider blocks) passes through untouched. */
export type OmpAssistantContent =
  | OmpTextContent
  | OmpToolCall
  | { type: string; [key: string]: unknown };

export interface OmpAssistantMessage {
  role: 'assistant';
  content: OmpAssistantContent[];
}
export interface OmpUserMessage {
  role: 'user';
  content: string | OmpAssistantContent[];
}
export interface OmpToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: { type: string; text?: string }[];
  isError?: boolean;
}
export type OmpMessage =
  | OmpAssistantMessage
  | OmpUserMessage
  | OmpToolResultMessage
  | { role: string; content?: unknown };

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is OmpTextContent => (part as OmpTextContent)?.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function resultText(message: OmpToolResultMessage): string {
  return (message.content ?? [])
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Folds omp's message stream into the library's shape.
 *
 * omp files a tool result as its own `role: "toolResult"` message, while the
 * library expects the result to hang off the following user message, paired by
 * id. Grouping here keeps the pairing logic in one place, and the returned
 * `index` lets a decision be mapped back onto the exact omp messages.
 */
export interface MappedTranscript {
  messages: Message[];
  /** Index in the mapped array -> indexes of the omp messages it came from. */
  origin: number[][];
}

export function mapOmpMessages(source: readonly OmpMessage[]): MappedTranscript {
  const messages: Message[] = [];
  const origin: number[][] = [];
  const pendingResults: ToolResult[] = [];
  const pendingOrigins: number[] = [];

  const flushResults = (): void => {
    if (pendingResults.length === 0) return;
    messages.push({ role: 'user', text: '', toolUses: [], toolResults: [...pendingResults] });
    origin.push([...pendingOrigins]);
    pendingResults.length = 0;
    pendingOrigins.length = 0;
  };

  source.forEach((message, index) => {
    if (message.role === 'toolResult') {
      const result = message as OmpToolResultMessage;
      pendingResults.push({
        tool_use_id: result.toolCallId,
        text: resultText(result),
        isError: result.isError === true,
      });
      pendingOrigins.push(index);
      return;
    }

    if (message.role === 'assistant') {
      flushResults();
      const content = (message as OmpAssistantMessage).content ?? [];
      const toolUses: ToolUse[] = content
        .filter((part): part is OmpToolCall => (part as OmpToolCall)?.type === 'toolCall')
        .map((part) => ({
          tool_use_id: part.id,
          tool: part.name,
          input: part.arguments ?? {},
        }));
      messages.push({ role: 'assistant', text: textOf(content), toolUses });
      origin.push([index]);
      return;
    }

    if (message.role === 'user' || message.role === 'developer') {
      flushResults();
      messages.push({ role: 'user', text: textOf((message as OmpUserMessage).content), toolUses: [] });
      origin.push([index]);
      return;
    }
  });

  flushResults();
  return { messages, origin };
}
