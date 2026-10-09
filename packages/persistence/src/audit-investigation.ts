import type { Records } from './records.js';

/** Explicit projections: audit reads never return runtime leases, encrypted credentials or embeddings. */
export const AUDIT_FIELDS = {
  toolCalls: [
    'id',
    'createdAt',
    'startedAt',
    'finishedAt',
    'step',
    'toolName',
    'status',
    'risk',
    'approvalId',
    'decision',
    'args',
    'result',
    'error',
  ],
  modelCalls: [
    'id',
    'createdAt',
    'role',
    'model',
    'inputTokens',
    'outputTokens',
    'costUsd',
    'latencyMs',
    'finishReason',
    'openrouterGenerationId',
  ],
  modelCallAudit: [
    'id',
    'createdAt',
    'modelCallId',
    'role',
    'model',
    'method',
    'capture',
    'systemPrompt',
    'input',
    'output',
    'truncated',
    'finishReason',
    'latencyMs',
    'inputTokens',
    'outputTokens',
  ],
  approvals: [
    'id',
    'requestedAt',
    'resolvedAt',
    'expiresAt',
    'status',
    'summary',
    'toolCallId',
    'resolvedVia',
    'payload',
    'resolutionPayload',
  ],
  messages: ['id', 'createdAt', 'role', 'text', 'origin', 'conversationId'],
  contextMessages: ['taskId', 'id', 'createdAt', 'role', 'text', 'origin', 'conversationId'],
  responseChecks: [
    'id',
    'createdAt',
    'promptVersion',
    'plannerVersion',
    'blocked',
    'unsupportedCount',
    'mustActRetries',
    'degradedSteps',
    'outputVerificationAttempted',
    'outputVerificationRevised',
    'outputVerificationUnavailable',
  ],
  recallMetrics: [
    'id',
    'createdAt',
    'path',
    'graphAttempted',
    'graphFailed',
    'historyFailed',
    'graphCandidates',
    'graphUsed',
    'historyTier',
    'historyUsed',
    'sourceCount',
  ],
} as const;
export type AuditSection = keyof typeof AUDIT_FIELDS;
export const AUDIT_SECTIONS = Object.keys(AUDIT_FIELDS) as AuditSection[];
export const AUDIT_TASK_FIELDS = [
  'id',
  'agentId',
  'createdAt',
  'updatedAt',
  'title',
  'status',
  'type',
  'trust',
  'progress',
  'nextAction',
  'conversationId',
  'parentTaskId',
  'goalId',
  'trigger',
  'plan',
  'attempt',
  'reclaimCount',
  'maxSteps',
  'budgetUsdLimit',
  'spentUsd',
  'runAfter',
  'deadline',
  'archivedAt',
  'state',
] as const;
export type AuditTask = Pick<Records['tasks'], (typeof AUDIT_TASK_FIELDS)[number]>;
export type AuditRow = { id: string; at: Date; data: Record<string, unknown> };
export type AuditCursor = { at: Date; id: string };
export interface AuditReadInput {
  section: AuditSection;
  limit: number;
  cursor?: AuditCursor;
  entryId?: string;
}
/** Both operations enforce the supplied agent's ownership, including every continuation. */
export interface AuditInvestigationRepository {
  task(agentId: string, taskId: string): Promise<AuditTask | null>;
  read(agentId: string, taskId: string, input: AuditReadInput): Promise<AuditRow[]>;
}
