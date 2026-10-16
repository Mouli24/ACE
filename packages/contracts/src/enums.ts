import { z } from 'zod';

/**
 * Every enum of round 1 §2.2, declared in this round even where the first use is later —
 * these literals are the ones CLAUDE.md §7 forbids drifting from. Each enum is exported three
 * ways: the literal tuple (`FOO_BARS`), the Zod schema (`FooBarSchema`) and the inferred type
 * (`FooBar`, the name §2.2 uses).
 */

export const DATA_TYPES = ['text', 'image', 'audio', 'video', 'code', 'json', 'file'] as const;
export const DataTypeSchema = z.enum(DATA_TYPES);
export type DataType = z.infer<typeof DataTypeSchema>;

export const NODE_KINDS = [
  'input',
  'agent',
  'model',
  'output',
  'merge',
  'transform',
  'retrieval',
  'guardrail',
  'custom',
] as const;
export const NodeKindSchema = z.enum(NODE_KINDS);
export type NodeKind = z.infer<typeof NodeKindSchema>;

/**
 * `data` carries a node's output into a port; `loop` repeats a body (round 3); `order` (D373) is
 * "run after" — a dependency between two nodes that carries nothing.
 */
export const EDGE_KINDS = ['data', 'loop', 'order'] as const;
export const EdgeKindSchema = z.enum(EDGE_KINDS);
export type EdgeKind = z.infer<typeof EdgeKindSchema>;

export const NODE_STATES = [
  'IDLE',
  'READY',
  'RUNNING',
  'WAITING',
  'COMPLETED',
  'PAUSED',
  'STOPPED',
  'BLOCKED',
  'FAILED',
] as const;
export const NodeStateSchema = z.enum(NODE_STATES);
export type NodeState = z.infer<typeof NodeStateSchema>;

export const RUN_STATES = [
  'PREFLIGHT',
  'RUNNING',
  'PAUSED',
  'COMPLETE',
  'BLOCKED',
  'HALTED',
] as const;
export const RunStateSchema = z.enum(RUN_STATES);
export type RunState = z.infer<typeof RunStateSchema>;

export const FAILURE_REASONS = [
  'RUN_FAILED',
  'CONTRACT_VIOLATION',
  'GUARDRAIL_VIOLATION',
  'BLOCKED',
] as const;
export const FailureReasonSchema = z.enum(FAILURE_REASONS);
export type FailureReason = z.infer<typeof FailureReasonSchema>;

export const HALT_REASONS = ['stopped', 'budget_exceeded', 'failure', 'shutdown', 'crash'] as const;
export const HaltReasonSchema = z.enum(HALT_REASONS);
export type HaltReason = z.infer<typeof HaltReasonSchema>;

export const PROVIDER_STATES = [
  'UNKNOWN',
  'CHECKING',
  'CONNECTED',
  'AUTH_FAILED',
  'UNREACHABLE',
  'RATE_LIMITED',
] as const;
export const ProviderStateSchema = z.enum(PROVIDER_STATES);
export type ProviderState = z.infer<typeof ProviderStateSchema>;

export const PROVIDER_TYPES = [
  'anthropic',
  'google',
  'openai',
  'openai_compatible',
  'ollama',
  'mock',
  // X1 (FR-PRV-008, D261): locally installed coding-agent CLIs, run with their own login.
  'claude_code',
  'codex_cli',
  'gemini_cli',
] as const;
export const ProviderTypeSchema = z.enum(PROVIDER_TYPES);
export type ProviderType = z.infer<typeof ProviderTypeSchema>;

export const ERROR_KINDS = [
  'user_cancelled',
  'agent',
  'provider',
  'auth',
  'network',
  'invalid_config',
  'workflow',
  'guardrail',
] as const;
export const ErrorKindSchema = z.enum(ERROR_KINDS);
export type ErrorKind = z.infer<typeof ErrorKindSchema>;

export const GUARDRAIL_ACTIONS = ['pass', 'warn', 'redact', 'ask_user', 'block'] as const;
export const GuardrailActionSchema = z.enum(GUARDRAIL_ACTIONS);
export type GuardrailAction = z.infer<typeof GuardrailActionSchema>;

export const GUARDRAIL_POINTS = [
  'input',
  'context',
  'tool',
  'output',
  'cost',
  'loop',
  'data',
] as const;
export const GuardrailPointSchema = z.enum(GUARDRAIL_POINTS);
export type GuardrailPoint = z.infer<typeof GuardrailPointSchema>;

export const ROUTING_POLICIES = ['fixed', 'fallback', 'capability', 'cost', 'latency'] as const;
export const RoutingPolicySchema = z.enum(ROUTING_POLICIES);
export type RoutingPolicy = z.infer<typeof RoutingPolicySchema>;
