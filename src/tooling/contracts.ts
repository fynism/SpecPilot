import type { z } from 'zod';

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: z.ZodType;
}
export interface ToolCall {
  name: string;
  input: unknown;
}
export type EventName =
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'
  | 'ClarificationRequested'
  | 'ClarificationAnswered'
  | 'ClarificationCancelled';
export type HookDispatcher = (event: EventName, ...args: unknown[]) => unknown;
