import type { Records } from '@assistant/persistence';
import { classifyToolCallEffectOutcome, compactToolCallReceipt } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { parseApplicationActionState, registerApplicationTools } from './applications.js';
import { ToolRegistry } from './registry.js';

describe('application action-state parsing', () => {
  it('preserves the opaque effect receipt and terminal unknown state', () => {
    const receipt = {
      claimToken: '00000000-0000-4000-8000-000000000001',
      producerPrivacyGeneration: null,
      argsDigest: 'a'.repeat(64),
      taskId: '00000000-0000-4000-8000-000000000002',
      toolCallId: '00000000-0000-4000-8000-000000000003',
      toolName: 'applications.apply_confirmation',
      idempotencyKey: 'application-confirmation-apply-00000000-0000-4000-8000-000000000004',
    };
    expect(
      parseApplicationActionState({
        sheet: { status: 'unknown', effectReceipt: receipt },
      }),
    ).toEqual({ sheet: { status: 'unknown', effectReceipt: receipt } });
  });

  it('fails closed when an effect receipt or stored status is malformed', () => {
    expect(
      parseApplicationActionState({
        sheet: { status: 'pending', effectReceipt: { claimToken: 'bad' } },
        document: { status: 'in_progress' },
      }),
    ).toEqual({
      sheet: {
        status: 'unknown',
        error: 'Stored effect receipt is malformed; automatic retry is suppressed.',
      },
      document: {
        status: 'unknown',
        error: 'Stored action state is malformed; automatic retry is suppressed.',
      },
    });
  });
});

describe('registered application tool receipt outcomes', () => {
  const ownerId = '00000000-0000-4000-8000-000000000001';
  const taskId = '00000000-0000-4000-8000-000000000002';
  const applicationId = '00000000-0000-4000-8000-000000000003';
  const toolCallId = '00000000-0000-4000-8000-000000000004';

  async function runRegisteredAction(
    action: 'sheet' | 'document',
    resultCase: 'provider-error' | 'settlement-error' | 'success',
  ) {
    const toolName =
      action === 'sheet'
        ? 'applications.apply_confirmation'
        : 'applications.append_confirmation_doc';
    const idempotencyKey =
      action === 'sheet'
        ? `application-confirmation-apply-${applicationId}`
        : `application-confirmation-doc-${applicationId}`;
    const update =
      action === 'sheet'
        ? {
            spreadsheetId: 'spreadsheet_123456789',
            sheetName: 'Applications',
            startCell: 'A2',
            rows: [['Example Corp', 'Engineer']],
          }
        : { documentId: 'document_123456789', content: 'Application received.' };
    const record = {
      id: applicationId,
      agentId: ownerId,
      company: 'Example Corp',
      role: 'Engineer',
      status: 'confirmation_received',
      producerPrivacyGeneration: null,
      trackerUpdate: action === 'sheet' ? update : null,
      documentUpdate: action === 'document' ? update : null,
      actionState:
        action === 'sheet' ? { sheet: { status: 'pending' } } : { document: { status: 'pending' } },
    };
    const clientApi = async (_url: string, init: RequestInit = {}) => {
      if (action === 'document' && (init.method ?? 'GET') === 'GET')
        return { body: { content: [{ endIndex: 1 }] } };
      if (resultCase === 'provider-error') throw new Error('provider response was lost');
      return {};
    };
    const applications = {
      get: async () => record,
      claimExternalEffect: async () => ({
        status: 'claimed',
        claimToken: '00000000-0000-4000-8000-000000000005',
        record,
      }),
      settleExternalEffect: async () => resultCase !== 'settlement-error',
    };
    const registry = new ToolRegistry();
    registerApplicationTools(registry, {
      client: { api: clientApi } as never,
      applications: applications as never,
      tasks: {
        getTask: async () =>
          ({
            agentId: ownerId,
            trigger: {
              source: 'internal',
              payload: { kind: 'application_confirmation', applicationId },
            },
          }) as never,
      },
    });
    const registered = registry.get(toolName)?.tool;
    if (!registered) throw new Error(`Tool was not registered: ${toolName}`);
    const execute = registered.execute as (args: unknown, context: unknown) => Promise<unknown>;
    const result = await execute(
      { applicationId },
      {
        taskId,
        taskLeaseToken: 'task-lease-token',
        agentId: ownerId,
        trust: 'assistant',
        tainted: false,
        db: {} as never,
        now: () => new Date(),
        signal: new AbortController().signal,
        log: async () => {},
        execution: { dbToolCallId: toolCallId, modelToolCallId: 'model-call', toolName },
      },
    );
    const toolCall = {
      id: toolCallId,
      taskId,
      status: 'succeeded',
      startedAt: new Date(),
      step: 1,
      toolName,
      args: { applicationId },
      risk: 'autonomous',
      idempotencyKey,
      result,
      error: null,
      approvalId: null,
      decision: { modelToolCallId: 'model-call' },
      finishedAt: new Date(),
      createdAt: new Date(),
    } satisfies Records['toolCalls'];
    return { result, toolCall };
  }

  it.each([
    ['sheet', 'provider-error'],
    ['sheet', 'settlement-error'],
    ['document', 'provider-error'],
    ['document', 'settlement-error'],
  ] as const)(
    'compacts registered %s %s as unknown despite successful handler completion',
    async (action, resultCase) => {
      const { result, toolCall } = await runRegisteredAction(action, resultCase);
      expect(result).toMatchObject({
        action,
        status: 'unknown',
        effectStatus: 'unknown',
        retrySuppressed: true,
      });
      expect(classifyToolCallEffectOutcome(toolCall)).toBe('unknown');
      expect(
        compactToolCallReceipt(toolCall, { agentId: ownerId, recordedAt: new Date() })
          ?.effectOutcome,
      ).toBe('unknown');
    },
  );

  it.each(['sheet', 'document'] as const)(
    'keeps a successfully settled registered %s action completed',
    async (action) => {
      const { result, toolCall } = await runRegisteredAction(action, 'success');
      expect(result).toEqual({ applicationId, action, status: 'succeeded' });
      expect(classifyToolCallEffectOutcome(toolCall)).toBe('completed');
      expect(
        compactToolCallReceipt(toolCall, { agentId: ownerId, recordedAt: new Date() })
          ?.effectOutcome,
      ).toBe('completed');
    },
  );
});
