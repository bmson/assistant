import { randomUUID } from 'node:crypto';
import { reloadConfig, resetConfigForTest } from '@assistant/config';
import { extractOwnerIntent } from '@assistant/core';
import type { Db } from '@assistant/db';
import type {
  ApprovalPolicyRepository,
  ApprovalRepository,
  CostRepository,
  Records,
  StartAutonomousToolCallInput,
  TaskLease,
  ToolExecutionRepository,
} from '@assistant/persistence';
import {
  approvalPolicyFingerprint,
  ownerPhoneProposalNeedsApproval,
  ownerPhoneRecipientRequest,
  phoneCallOwnerNumberReviewSourceFingerprint,
} from '@assistant/persistence';
import { taskFixture } from '@assistant/persistence/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolDispatcher } from './dispatcher.js';
import { policyTemplates } from './policies.js';
import { ToolRegistry } from './registry.js';
import type { ToolContext } from './types.js';

function toolCallRow(
  input: Omit<StartAutonomousToolCallInput, 'expectedPolicyFingerprint'>,
): Records['toolCalls'] {
  return {
    id: randomUUID(),
    createdAt: new Date(),
    status: 'executing',
    taskId: input.taskId,
    startedAt: new Date(),
    step: input.step,
    toolName: input.toolName,
    args: input.args,
    risk: 'autonomous',
    idempotencyKey: input.idempotencyKey,
    result: null,
    error: null,
    approvalId: null,
    decision: input.decision,
    finishedAt: null,
  };
}

function unexpected<T>(label: string): Promise<T> {
  return Promise.reject(new Error(`Unexpected synthetic fixture call: ${label}`));
}

function makeRepositories() {
  let approvedCall: Records['toolCalls'] | null = null;
  let approvedTask: TaskLease | null = null;
  let approvedApproval: Records['approvals'] | null = null;
  let currentTask: TaskLease | null = null;
  let startedCall: Records['toolCalls'] | null = null;
  const started = vi.fn(async (input: StartAutonomousToolCallInput) => {
    startedCall = toolCallRow(input);
    return startedCall;
  });
  const outcome = vi.fn(async () => true);
  const contacts = vi.fn(async () => [] as Array<{ emails: string[]; phones: string[] }>);
  const execution: ToolExecutionRepository = {
    kind: 'tool-execution-repository',
    load: async (_agentId, taskId, toolCallId) => {
      if (approvedCall && approvedTask) {
        return { toolCall: approvedCall, task: approvedTask, approval: approvedApproval };
      }
      return currentTask?.id === taskId && startedCall?.id === toolCallId
        ? { toolCall: startedCall, task: currentTask, approval: null }
        : null;
    },
    findByModelToolCallId: async () => null,
    findReceiptByToolCallId: async () => null,
    findReceiptByModelToolCallId: async () => null,
    findReceiptByIdempotencyKey: async () => null,
    claim: async () => unexpected('execution.claim'),
    outcome,
    contacts,
    underRateLimit: async () => true,
    cacheGet: async () => null,
    cachePut: async () => {},
    start: started,
    findIdempotent: async () => null,
    cached: async (input) => toolCallRow(input),
    parentIsMission: async () => false,
    conversationGoalId: async () => null,
    goalWorkEvidence: async () => [],
    ownerMessageHistory: async () => [],
    searchResults: async () => [],
  };
  const costs: CostRepository = {
    kind: 'cost-repository',
    getRate: async () => null,
    totals: async () => ({
      dailySpentUsd: 0,
      monthlySpentUsd: 0,
      heldUsd: 0,
      dailyLimitUsd: 10,
      monthlyLimitUsd: 100,
      softPct: 80,
    }),
    reserve: async () => unexpected('costs.reserve'),
    beginAttempt: async () => unexpected('costs.beginAttempt'),
    markAttemptUnknown: async () => unexpected('costs.markAttemptUnknown'),
    record: async () => unexpected('costs.record'),
    reconcile: async () => unexpected('costs.reconcile'),
    release: async () => unexpected('costs.release'),
    releaseStale: async () => 0,
  };
  const approvals: ApprovalRepository = {
    kind: 'approval-repository',
    create: async () => unexpected('approvals.create'),
    getRememberable: async () => null,
    listInbox: async () => unexpected('approvals.listInbox'),
    listStalledNotices: async () => [],
    markNotified: async () => unexpected('approvals.markNotified'),
    resolve: async () => unexpected('approvals.resolve'),
    expireStale: async () => [],
    resumeResolved: async () => [],
  };
  const policies: ApprovalPolicyRepository = {
    kind: 'approval-policy-repository',
    list: vi.fn(async () => []),
    setEnabled: async () => false,
    delete: async () => false,
  };
  return {
    execution,
    costs,
    approvals,
    policies,
    started,
    outcome,
    contacts,
    setApprovedCall(
      task: TaskLease,
      call: Records['toolCalls'],
      approval: Records['approvals'] | null = null,
    ) {
      approvedTask = task;
      approvedCall = call;
      approvedApproval = approval;
    },
    setCurrentTask(task: TaskLease) {
      currentTask = task;
    },
  };
}

function fixture(docsReplayKey = false, preparedDocumentId?: string) {
  // Nothing in this fixture may use the database; required dispatcher ports are injected below.
  // An accidental database method call will fail because this inert object has no methods.
  const noDatabase = new Proxy({} as Db, { get: () => undefined });
  const repositories = makeRepositories();
  const read = vi.fn(async () => ({ messages: [] }));
  const send = vi.fn(async () => ({ messageId: 'synthetic-send' }));
  const calendarRead = vi.fn(async () => ({ events: [] }));
  const docsRead = vi.fn(async () => ({ text: 'synthetic document' }));
  const driveRead = vi.fn(async () => ({ text: 'synthetic file' }));
  const sheetsRead = vi.fn(async () => ({ rows: [] }));
  const registry = new ToolRegistry()
    .register(
      {
        name: 'gmail.search',
        description: 'synthetic private mailbox read',
        inputSchema: z.object({}),
        risk: 'autonomous',
        acceptsUntrustedInput: true,
        execute: read,
      },
      { confidentialRead: true },
    )
    .register(
      {
        name: 'gmail.send',
        description: 'synthetic outbound message',
        inputSchema: z.object({}),
        risk: 'autonomous',
        acceptsUntrustedInput: true,
        execute: send,
      },
      { outwardFacing: true },
    )
    .register(
      {
        name: 'calendar.list_events',
        description: 'synthetic private calendar read',
        inputSchema: z.object({}),
        risk: 'autonomous',
        acceptsUntrustedInput: true,
        execute: calendarRead,
      },
      { confidentialRead: true },
    )
    .register(
      {
        name: 'docs.get',
        description: 'synthetic private Google Doc read',
        ...(docsReplayKey ? { idempotencyKey: () => 'same-recorded-doc-read' } : {}),
        ...(preparedDocumentId
          ? {
              prepare: async (args: unknown) => ({
                ...(args as Record<string, unknown>),
                documentId: preparedDocumentId,
              }),
            }
          : {}),
        inputSchema: z.object({ documentId: z.string().optional() }),
        risk: 'autonomous',
        acceptsUntrustedInput: true,
        execute: docsRead,
      },
      { confidentialRead: true },
    )
    .register(
      {
        name: 'drive.read',
        description: 'synthetic private Google Drive read',
        inputSchema: z.object({}),
        risk: 'autonomous',
        acceptsUntrustedInput: true,
        execute: driveRead,
      },
      { confidentialRead: true },
    )
    .register(
      {
        name: 'sheets.get_rows',
        description: 'synthetic private Google Sheets read',
        inputSchema: z.object({}),
        risk: 'autonomous',
        acceptsUntrustedInput: true,
        execute: sheetsRead,
      },
      { confidentialRead: true },
    );
  const dispatcher = new ToolDispatcher(
    noDatabase,
    registry,
    repositories.execution,
    repositories.costs,
    repositories.approvals,
    repositories.policies,
  );
  const taskBase = taskFixture({
    id: randomUUID(),
    agentId: randomUUID(),
    conversationId: randomUUID(),
    reminderId: randomUUID(),
  });
  const task: TaskLease = {
    ...taskBase,
    type: 'chat_turn',
    status: 'running',
    trigger: { source: 'chat', payload: { text: '' } },
    leaseToken: 'synthetic-running-lease',
    lockedUntil: new Date(Date.now() + 60_000),
  };
  repositories.setCurrentTask(task);
  let step = 0;
  const makeContext = (text: string): ToolContext => {
    const ownerIntent = extractOwnerIntent({ trust: 'owner', text });
    return {
      taskId: task.id,
      agentId: task.agentId,
      conversationId: task.conversationId ?? undefined,
      trust: 'owner',
      tainted: false,
      ownerIntent,
      db: noDatabase,
      now: () => new Date('2026-10-08T12:00:00.000Z'),
      signal: new AbortController().signal,
      log: async () => {},
    };
  };
  const dispatch = (
    text: string,
    toolName: string,
    args: Record<string, unknown> = {},
    tainted = false,
  ) => {
    const ctx = makeContext(text);
    ctx.tainted = tainted;
    const next = ++step;
    return dispatcher.dispatch({
      task,
      step: next,
      modelToolCallId: `synthetic-model-${next}`,
      toolName,
      args,
      ctx,
      provenance: { plannerVersion: 1, promptVersion: 1, model: 'synthetic/p03' },
    });
  };
  const makeApprovedCall = (
    toolName: string,
    args: Record<string, unknown> = {},
    status: Records['toolCalls']['status'] = 'approved',
    result: unknown = null,
    resolutionPayload?: Record<string, unknown>,
  ) => {
    const row = toolCallRow({
      agentId: task.agentId,
      taskId: task.id,
      toolName,
      args,
      step: ++step,
      idempotencyKey: `approved-${step}`,
      decision: {},
    });
    row.status = status;
    row.result = result;
    let approval: Records['approvals'] | null = null;
    if (resolutionPayload) {
      row.approvalId = 'synthetic-approval';
      approval = {
        id: 'synthetic-approval',
        status: 'approved',
        expiresAt: new Date(Date.now() + 60_000),
        taskId: task.id,
        resolvedAt: null,
        summary: 'synthetic approved Docs call',
        toolCallId: row.id,
        shortCode: '123456',
        payload: args,
        resolutionPayload,
        requestedAt: new Date(),
        resolvedVia: null,
        notifiedChannels: [],
        createdPolicyId: null,
      };
    }
    repositories.setApprovedCall(task, row, approval);
    return { callId: row.id, ctx: (text: string) => makeContext(text) };
  };
  return {
    dispatch,
    registry,
    makeApprovedCall,
    dispatcher,
    read,
    send,
    calendarRead,
    docsRead,
    driveRead,
    sheetsRead,
    task,
    repositories,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('P03 owner intent at ToolDispatcher boundary (synthetic repositories only)', () => {
  it('executes the direct authorized Gmail read positive control', async () => {
    const { dispatch, read, task, repositories } = fixture();
    const disabledPolicy: Records['approvalPolicies'] = {
      id: randomUUID(),
      agentId: task.agentId,
      toolName: 'gmail.search',
      templateKey: 'gmail.send.to_recipient',
      match: { recipient: 'owner@example.invalid' },
      effect: 'deny',
      enabled: false,
      version: 1,
      createdVia: 'settings',
      createdAt: new Date('2026-10-08T12:00:00.000Z'),
      updatedAt: new Date('2026-10-08T12:00:00.000Z'),
    };
    vi.mocked(repositories.policies.list).mockResolvedValue([disabledPolicy]);
    expect(await dispatch('Read my Gmail for the invoice.', 'gmail.search')).toMatchObject({
      kind: 'executed',
    });
    expect(read).toHaveBeenCalledOnce();
    expect(repositories.policies.list).toHaveBeenCalledWith(task.agentId, {
      toolName: 'gmail.search',
    });
    expect(repositories.started.mock.calls[0]?.[0].expectedPolicyFingerprint).toBe(
      approvalPolicyFingerprint([disabledPolicy]),
    );
  });

  it('blocks an explicit no-read request before gmail.search execute', async () => {
    const { dispatch, read } = fixture();
    const result = await dispatch(
      "Don't read Gmail; explain what Gmail labels mean.",
      'gmail.search',
    );
    expect(result).toMatchObject({ kind: 'rejected' });
    expect(read).not.toHaveBeenCalled();
  });

  it('blocks email aliases and leaves unrelated explicitly allowed calendar reads available', async () => {
    const { dispatch, read, calendarRead } = fixture();
    const result = await dispatch(
      'Do not access my email, but check my calendar for Friday.',
      'gmail.search',
    );
    expect(result).toMatchObject({ kind: 'rejected' });
    expect(read).not.toHaveBeenCalled();

    expect(
      await dispatch(
        'Do not access my email, but check my calendar for Friday.',
        'calendar.list_events',
      ),
    ).toMatchObject({ kind: 'executed' });
    expect(calendarRead).toHaveBeenCalledOnce();
  });

  it('stops a following affirmative read from inheriting the preceding Gmail prohibition', async () => {
    const { dispatch, read, calendarRead } = fixture();
    const text = "Don't read Gmail, and do check my calendar for Friday.";
    expect(await dispatch(text, 'gmail.search')).toMatchObject({ kind: 'rejected' });
    expect(read).not.toHaveBeenCalled();

    expect(await dispatch(text, 'calendar.list_events')).toMatchObject({ kind: 'executed' });
    expect(calendarRead).toHaveBeenCalledOnce();
  });

  it('does not mistake a meeting mentioned in prohibited email for a calendar prohibition', async () => {
    const { dispatch, read, calendarRead } = fixture();
    const text = "Don't read the email about my meeting; check my calendar for Friday.";
    expect(await dispatch(text, 'gmail.search')).toMatchObject({ kind: 'rejected' });
    expect(read).not.toHaveBeenCalled();

    expect(await dispatch(text, 'calendar.list_events')).toMatchObject({ kind: 'executed' });
    expect(calendarRead).toHaveBeenCalledOnce();
  });

  it('does not treat a source named in email context as a second prohibited source', async () => {
    const { dispatch, read, calendarRead } = fixture();
    const text = "Don't read the email about the calendar invite; check my calendar for Friday.";
    expect(await dispatch(text, 'gmail.search')).toMatchObject({ kind: 'rejected' });
    expect(read).not.toHaveBeenCalled();

    expect(await dispatch(text, 'calendar.list_events')).toMatchObject({ kind: 'executed' });
    expect(calendarRead).toHaveBeenCalledOnce();
  });

  it('allows a direct Docs read when the prohibition names Gmail before the Doc context', async () => {
    const { dispatch, read, docsRead } = fixture();
    const text = "Don't read Gmail about the Google Doc; open the Google Doc.";
    expect(await dispatch(text, 'gmail.search')).toMatchObject({ kind: 'rejected' });
    expect(read).not.toHaveBeenCalled();

    expect(await dispatch(text, 'docs.get')).toMatchObject({ kind: 'executed' });
    expect(docsRead).toHaveBeenCalledOnce();
  });

  it('blocks each explicitly coordinated source in a direct no-read list', async () => {
    const { dispatch, read, calendarRead } = fixture();
    const text = "Don't read Gmail or calendar for this.";
    expect(await dispatch(text, 'gmail.search')).toMatchObject({ kind: 'rejected' });
    expect(await dispatch(text, 'calendar.list_events')).toMatchObject({ kind: 'rejected' });
    expect(read).not.toHaveBeenCalled();
    expect(calendarRead).not.toHaveBeenCalled();
  });

  it.each([
    [
      'Do not open this Google Doc; explain what a Google Doc URL looks like.',
      'docs.get',
      'docsRead',
    ],
    ['Do not read my Google Drive; describe its URL format.', 'drive.read', 'driveRead'],
    ['Do not open the Google Sheet; explain spreadsheet URLs.', 'sheets.get_rows', 'sheetsRead'],
  ])('blocks only the named workspace source: %s', async (text, toolName, callbackName) => {
    const f = fixture();
    expect(await f.dispatch(text, toolName)).toMatchObject({ kind: 'rejected' });
    expect(f[callbackName as 'docsRead' | 'driveRead' | 'sheetsRead']).not.toHaveBeenCalled();
  });

  it('blocks a no-read Google document explanation before docs.get', async () => {
    const { dispatch, docsRead } = fixture();
    const text =
      'Do not open this document; explain what a Google Doc URL looks like: https://docs.google.com/document/d/NoReadDoc123456/edit';
    expect(await dispatch(text, 'docs.get')).toMatchObject({ kind: 'rejected' });
    expect(docsRead).not.toHaveBeenCalled();
  });

  it('allows a direct document read when the owner requests it', async () => {
    const { dispatch, docsRead } = fixture();
    expect(await dispatch('Open this document.', 'docs.get')).toMatchObject({ kind: 'executed' });
    expect(docsRead).toHaveBeenCalledOnce();
  });

  it('binds a Docs prohibition to one URL and permits a separately named affirmative URL', async () => {
    const { dispatch, docsRead } = fixture();
    const deniedId = 'DeniedDoc123456';
    const allowedId = 'AllowedDoc123456';
    const text = `Do not open this document: https://docs.google.com/document/d/${deniedId}/edit; open this document: https://docs.google.com/document/d/${allowedId}/edit.`;

    expect(await dispatch(text, 'docs.get', { documentId: deniedId })).toMatchObject({
      kind: 'rejected',
    });
    expect(docsRead).not.toHaveBeenCalled();
    expect(await dispatch(text, 'docs.get', { documentId: allowedId })).toMatchObject({
      kind: 'executed',
    });
    expect(docsRead).toHaveBeenCalledOnce();
  });

  it('handles affirmative Docs target after but/and while binding the first URL prohibition', async () => {
    const deniedId = 'DeniedDoc123456';
    const allowedId = 'AllowedDoc123456';
    for (const connector of ['but', 'and']) {
      const { dispatch, docsRead } = fixture();
      const text = `Do not open this document: https://docs.google.com/document/d/${deniedId}/edit, ${connector} open this document: https://docs.google.com/document/d/${allowedId}/edit.`;
      expect(await dispatch(text, 'docs.get', { documentId: deniedId })).toMatchObject({
        kind: 'rejected',
      });
      expect(await dispatch(text, 'docs.get', { documentId: allowedId })).toMatchObject({
        kind: 'executed',
      });
      expect(docsRead).toHaveBeenCalledOnce();
    }
  });

  it('binds a directly prohibited Docs URL even when the owner omits a Doc noun', async () => {
    const { dispatch, docsRead } = fixture();
    const deniedId = 'DeniedDoc123456';
    const allowedId = 'AllowedDoc123456';
    const text = `Do not open https://docs.google.com/document/d/${deniedId}/edit; open https://docs.google.com/document/d/${allowedId}/edit.`;
    expect(await dispatch(text, 'docs.get', { documentId: deniedId })).toMatchObject({
      kind: 'rejected',
    });
    expect(await dispatch(text, 'docs.get', { documentId: allowedId })).toMatchObject({
      kind: 'executed',
    });
    expect(docsRead).toHaveBeenCalledOnce();
  });

  it('does not let a target exception bypass the existing tainted-scope check', async () => {
    const { dispatch, docsRead } = fixture();
    const deniedId = 'DeniedDoc123456';
    const allowedId = 'AllowedDoc123456';
    const text = `Do not open this document: https://docs.google.com/document/d/${deniedId}/edit; open this document: https://docs.google.com/document/d/${allowedId}/edit.`;
    const result = await dispatch(text, 'docs.get', { documentId: allowedId }, true);
    expect(result).toMatchObject({ kind: 'rejected' });
    expect(result.kind === 'rejected' && result.reason).toContain(
      'no positively authored owner request authorized this action',
    );
    expect(docsRead).not.toHaveBeenCalled();
  });

  it('fails closed for an unmentioned Docs target and keeps unqualified Docs prohibitions source-wide', async () => {
    const { dispatch, docsRead } = fixture();
    const deniedId = 'DeniedDoc123456';
    const unknownId = 'UnknownDoc123456';
    const targeted = `Do not open this document: https://docs.google.com/document/d/${deniedId}/edit.`;
    expect(await dispatch(targeted, 'docs.get', { documentId: unknownId })).toMatchObject({
      kind: 'rejected',
    });
    expect(
      await dispatch('Never read my Google Docs; explain the URL format.', 'docs.get', {
        documentId: unknownId,
      }),
    ).toMatchObject({ kind: 'rejected' });
    expect(docsRead).not.toHaveBeenCalled();
  });

  it('does not treat a quoted second URL as owner authorization', async () => {
    const { dispatch, docsRead } = fixture();
    const deniedId = 'DeniedDoc123456';
    const quotedId = 'QuotedDoc123456';
    const text = `Do not open this document: https://docs.google.com/document/d/${deniedId}/edit; explain this quote: “Open https://docs.google.com/document/d/${quotedId}/edit.”`;
    expect(await dispatch(text, 'docs.get', { documentId: quotedId })).toMatchObject({
      kind: 'rejected',
    });
    expect(docsRead).not.toHaveBeenCalled();
  });

  it('rechecks the current Docs target before returning an approved-call result', async () => {
    const { makeApprovedCall, dispatcher, docsRead } = fixture();
    const deniedId = 'DeniedDoc123456';
    const allowedId = 'AllowedDoc123456';
    const text = `Do not open this document: https://docs.google.com/document/d/${deniedId}/edit; open this document: https://docs.google.com/document/d/${allowedId}/edit.`;

    const denied = makeApprovedCall('docs.get', { documentId: deniedId }, 'succeeded', {
      text: 'private denied result',
    });
    expect(await dispatcher.executeApproved(denied.callId, denied.ctx(text))).toMatchObject({
      kind: 'failed',
    });
    expect(docsRead).not.toHaveBeenCalled();

    const allowed = makeApprovedCall('docs.get', { documentId: allowedId }, 'succeeded', {
      text: 'approved target result',
    });
    expect(await dispatcher.executeApproved(allowed.callId, allowed.ctx(text))).toMatchObject({
      kind: 'executed',
      result: { text: 'approved target result' },
    });
    expect(docsRead).not.toHaveBeenCalled();
  });

  it('checks the effective resolution payload before returning an approved Docs result', async () => {
    const { makeApprovedCall, dispatcher, docsRead } = fixture();
    const deniedId = 'DeniedDoc123456';
    const allowedId = 'AllowedDoc123456';
    const text = `Do not open this document: https://docs.google.com/document/d/${deniedId}/edit; open this document: https://docs.google.com/document/d/${allowedId}/edit.`;
    const call = makeApprovedCall(
      'docs.get',
      { documentId: allowedId },
      'succeeded',
      { text: 'private denied payload result' },
      { documentId: deniedId },
    );
    expect(await dispatcher.executeApproved(call.callId, call.ctx(text))).toMatchObject({
      kind: 'failed',
    });
    expect(docsRead).not.toHaveBeenCalled();
  });

  it('keeps an explanatory how-to URL from authorizing a different Docs target', async () => {
    const { dispatch, docsRead } = fixture();
    const deniedId = 'DeniedDoc123456';
    const explainedId = 'ExplainedDoc123456';
    const allowedId = 'AllowedDoc123456';
    const text = `Do not open https://docs.google.com/document/d/${deniedId}/edit. Explain how to open https://docs.google.com/document/d/${explainedId}/edit. Open https://docs.google.com/document/d/${allowedId}/edit.`;
    expect(await dispatch(text, 'docs.get', { documentId: explainedId })).toMatchObject({
      kind: 'rejected',
    });
    expect(await dispatch(text, 'docs.get', { documentId: allowedId })).toMatchObject({
      kind: 'executed',
    });
    expect(docsRead).toHaveBeenCalledOnce();
  });

  it('fails closed for a compact Docs receipt when its resource arguments have expired', async () => {
    const { dispatcher, repositories, makeApprovedCall } = fixture();
    const deniedId = 'DeniedDoc123456';
    const ctx = makeApprovedCall('docs.get').ctx(
      `Do not open this document: https://docs.google.com/document/d/${deniedId}/edit.`,
    );
    const receipt = {
      id: randomUUID(),
      agentId: ctx.agentId,
      taskId: ctx.taskId,
      toolCallId: 'compact-doc-receipt',
      modelToolCallIdHash: null,
      idempotencyKeyHash: null,
      toolName: 'docs.get',
      effectOutcome: 'completed',
      recordedAt: new Date(),
    } satisfies Records['toolCallReceipts'];
    vi.spyOn(repositories.execution, 'findReceiptByToolCallId').mockResolvedValue(receipt);
    const result = await dispatcher.executeApproved(receipt.toolCallId, ctx);
    expect(result).toMatchObject({ kind: 'failed' });
  });

  it('does not authorize an explanatory instruction object as a Docs target', async () => {
    const { dispatch, docsRead } = fixture();
    const deniedId = 'DeniedDoc123456';
    const explainedId = 'ExplainedDoc123456';
    const text = `Do not open https://docs.google.com/document/d/${deniedId}/edit; Open instructions about how to open https://docs.google.com/document/d/${explainedId}/edit`;
    expect(await dispatch(text, 'docs.get', { documentId: explainedId })).toMatchObject({
      kind: 'rejected',
    });
    expect(docsRead).not.toHaveBeenCalled();
  });

  it('allows a polite direct request for a bare Docs URL', async () => {
    const { dispatch, docsRead } = fixture();
    const deniedId = 'DeniedDoc123456';
    const allowedId = 'AllowedDoc123456';
    const text = `Do not open https://docs.google.com/document/d/${deniedId}/edit; please open https://docs.google.com/document/d/${allowedId}/edit.`;
    expect(await dispatch(text, 'docs.get', { documentId: allowedId })).toMatchObject({
      kind: 'executed',
    });
    expect(docsRead).toHaveBeenCalledOnce();
  });

  it('allows a polite direct question naming the Google document target', async () => {
    const { dispatch, docsRead } = fixture();
    const deniedId = 'DeniedDoc123456';
    const allowedId = 'AllowedDoc123456';
    const text = `Do not open https://docs.google.com/document/d/${deniedId}/edit; could you please open this Google document at https://docs.google.com/document/d/${allowedId}/edit?`;
    expect(await dispatch(text, 'docs.get', { documentId: allowedId })).toMatchObject({
      kind: 'executed',
    });
    expect(docsRead).toHaveBeenCalledOnce();
  });

  it('checks the recorded document rather than the new args on a model-call replay', async () => {
    const { dispatch, makeApprovedCall, repositories, docsRead } = fixture();
    const text =
      'Do not open https://docs.google.com/document/d/DeniedDoc123456/edit; open https://docs.google.com/document/d/AllowedDoc123456/edit';
    const call = makeApprovedCall('docs.get', { documentId: 'DeniedDoc123456' }, 'succeeded', {
      text: 'private denied result',
    });
    const prior = await repositories.execution.load(
      call.ctx(text).agentId,
      call.ctx(text).taskId,
      call.callId,
    );
    vi.spyOn(repositories.execution, 'findByModelToolCallId').mockResolvedValue(prior);
    expect(await dispatch(text, 'docs.get', { documentId: 'AllowedDoc123456' })).toMatchObject({
      kind: 'rejected',
    });
    expect(docsRead).not.toHaveBeenCalled();
  });

  it('returns a permitted recorded model-call result without another read', async () => {
    const { dispatch, makeApprovedCall, repositories, docsRead } = fixture();
    const text =
      'Do not open https://docs.google.com/document/d/DeniedDoc123456/edit; open https://docs.google.com/document/d/AllowedDoc123456/edit';
    const call = makeApprovedCall('docs.get', { documentId: 'AllowedDoc123456' }, 'succeeded', {
      text: 'allowed result',
    });
    const prior = await repositories.execution.load(
      call.ctx(text).agentId,
      call.ctx(text).taskId,
      call.callId,
    );
    vi.spyOn(repositories.execution, 'findByModelToolCallId').mockResolvedValue(prior);
    expect(await dispatch(text, 'docs.get', { documentId: 'AllowedDoc123456' })).toMatchObject({
      kind: 'executed',
      result: { text: 'allowed result' },
    });
    expect(docsRead).not.toHaveBeenCalled();
  });

  it('checks effective approved args on a recorded model-call result', async () => {
    const { dispatch, makeApprovedCall, repositories, docsRead } = fixture();
    const text =
      'Do not open https://docs.google.com/document/d/DeniedDoc123456/edit; open https://docs.google.com/document/d/AllowedDoc123456/edit';
    const call = makeApprovedCall(
      'docs.get',
      { documentId: 'AllowedDoc123456' },
      'succeeded',
      { text: 'private approved result' },
      { documentId: 'DeniedDoc123456' },
    );
    const prior = await repositories.execution.load(
      call.ctx(text).agentId,
      call.ctx(text).taskId,
      call.callId,
    );
    vi.spyOn(repositories.execution, 'findByModelToolCallId').mockResolvedValue(prior);
    expect(await dispatch(text, 'docs.get', { documentId: 'AllowedDoc123456' })).toMatchObject({
      kind: 'rejected',
    });
    expect(docsRead).not.toHaveBeenCalled();
  });

  it('fails closed for a compact model-call receipt without document arguments', async () => {
    const { dispatch, makeApprovedCall, repositories, docsRead } = fixture();
    const text =
      'Do not open https://docs.google.com/document/d/DeniedDoc123456/edit; open https://docs.google.com/document/d/AllowedDoc123456/edit';
    const call = makeApprovedCall('docs.get', { documentId: 'AllowedDoc123456' });
    const prior = await repositories.execution.load(
      call.ctx(text).agentId,
      call.ctx(text).taskId,
      call.callId,
    );
    if (!prior) throw new Error('missing synthetic call');
    vi.spyOn(repositories.execution, 'findReceiptByModelToolCallId').mockResolvedValue({
      id: randomUUID(),
      agentId: prior.task.agentId,
      taskId: prior.task.id,
      toolCallId: call.callId,
      modelToolCallIdHash: null,
      idempotencyKeyHash: null,
      toolName: 'docs.get',
      effectOutcome: 'completed',
      recordedAt: new Date(),
    });
    expect(await dispatch(text, 'docs.get', { documentId: 'AllowedDoc123456' })).toMatchObject({
      kind: 'rejected',
    });
    expect(docsRead).not.toHaveBeenCalled();
  });

  it('checks the latest recorded resource after an executing-call reconciliation race', async () => {
    const { dispatch, makeApprovedCall, repositories, docsRead } = fixture();
    const text =
      'Do not open https://docs.google.com/document/d/DeniedDoc123456/edit; open https://docs.google.com/document/d/AllowedDoc123456/edit';
    const pending = makeApprovedCall('docs.get', { documentId: 'AllowedDoc123456' }, 'executing');
    const initial = await repositories.execution.load(
      pending.ctx(text).agentId,
      pending.ctx(text).taskId,
      pending.callId,
    );
    const denied = makeApprovedCall('docs.get', { documentId: 'DeniedDoc123456' }, 'succeeded', {
      text: 'private raced result',
    });
    const latest = await repositories.execution.load(
      denied.ctx(text).agentId,
      denied.ctx(text).taskId,
      denied.callId,
    );
    vi.spyOn(repositories.execution, 'findByModelToolCallId')
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(latest);
    repositories.outcome.mockResolvedValue(false);
    expect(await dispatch(text, 'docs.get', { documentId: 'AllowedDoc123456' })).toMatchObject({
      kind: 'rejected',
    });
    expect(docsRead).not.toHaveBeenCalled();
  });

  it('checks a stored idempotency result resource before returning it', async () => {
    const { dispatch, makeApprovedCall, repositories, docsRead } = fixture(true);
    const text =
      'Do not open https://docs.google.com/document/d/DeniedDoc123456/edit; open https://docs.google.com/document/d/AllowedDoc123456/edit';
    const call = makeApprovedCall('docs.get', { documentId: 'DeniedDoc123456' }, 'succeeded', {
      text: 'private idempotency result',
    });
    const prior = await repositories.execution.load(
      call.ctx(text).agentId,
      call.ctx(text).taskId,
      call.callId,
    );
    vi.spyOn(repositories.execution, 'findIdempotent').mockResolvedValue(prior?.toolCall ?? null);
    expect(await dispatch(text, 'docs.get', { documentId: 'AllowedDoc123456' })).toMatchObject({
      kind: 'rejected',
    });
    expect(docsRead).not.toHaveBeenCalled();
  });

  it('returns the permitted idempotency result without another read', async () => {
    const { dispatch, makeApprovedCall, repositories, docsRead } = fixture(true);
    const text =
      'Do not open https://docs.google.com/document/d/DeniedDoc123456/edit; open https://docs.google.com/document/d/AllowedDoc123456/edit';
    const call = makeApprovedCall('docs.get', { documentId: 'AllowedDoc123456' }, 'succeeded', {
      text: 'allowed idempotency result',
    });
    const prior = await repositories.execution.load(
      call.ctx(text).agentId,
      call.ctx(text).taskId,
      call.callId,
    );
    vi.spyOn(repositories.execution, 'findIdempotent').mockResolvedValue(prior?.toolCall ?? null);
    expect(await dispatch(text, 'docs.get', { documentId: 'AllowedDoc123456' })).toMatchObject({
      kind: 'executed',
      result: { text: 'allowed idempotency result' },
    });
    expect(docsRead).not.toHaveBeenCalled();
  });

  it('rejects a prepared resource that resolves to the prohibited document', async () => {
    const { dispatch, docsRead, repositories } = fixture(false, 'DeniedDoc123456');
    const text =
      'Do not open https://docs.google.com/document/d/DeniedDoc123456/edit; open https://docs.google.com/document/d/AllowedDoc123456/edit';
    expect(await dispatch(text, 'docs.get', { documentId: 'AllowedDoc123456' })).toMatchObject({
      kind: 'rejected',
    });
    expect(docsRead).not.toHaveBeenCalled();
    expect(repositories.started).not.toHaveBeenCalled();
  });

  it('checks effective approved args on an idempotency result', async () => {
    const { dispatch, makeApprovedCall, repositories, docsRead } = fixture(true);
    const text =
      'Do not open https://docs.google.com/document/d/DeniedDoc123456/edit; open https://docs.google.com/document/d/AllowedDoc123456/edit';
    const call = makeApprovedCall(
      'docs.get',
      { documentId: 'AllowedDoc123456' },
      'succeeded',
      { text: 'private resolved result' },
      { documentId: 'DeniedDoc123456' },
    );
    const prior = await repositories.execution.load(
      call.ctx(text).agentId,
      call.ctx(text).taskId,
      call.callId,
    );
    vi.spyOn(repositories.execution, 'findIdempotent').mockResolvedValue(prior?.toolCall ?? null);
    expect(await dispatch(text, 'docs.get', { documentId: 'AllowedDoc123456' })).toMatchObject({
      kind: 'rejected',
    });
    expect(docsRead).not.toHaveBeenCalled();
  });

  it('returns the explicitly permitted effective approval result by idempotency identity', async () => {
    const { dispatch, makeApprovedCall, repositories, docsRead } = fixture(true);
    const text =
      'Do not open https://docs.google.com/document/d/DeniedDoc123456/edit; open https://docs.google.com/document/d/AllowedDoc123456/edit';
    const call = makeApprovedCall(
      'docs.get',
      { documentId: 'DeniedDoc123456' },
      'succeeded',
      { text: 'approved allowed result' },
      { documentId: 'AllowedDoc123456' },
    );
    const prior = await repositories.execution.load(
      call.ctx(text).agentId,
      call.ctx(text).taskId,
      call.callId,
    );
    vi.spyOn(repositories.execution, 'findIdempotent').mockResolvedValue(prior?.toolCall ?? null);
    expect(await dispatch(text, 'docs.get', { documentId: 'AllowedDoc123456' })).toMatchObject({
      kind: 'executed',
      result: { text: 'approved allowed result' },
    });
    expect(docsRead).not.toHaveBeenCalled();
  });

  it('fails closed for an idempotency receipt whose document arguments expired', async () => {
    const { dispatch, makeApprovedCall, repositories, docsRead } = fixture(true);
    const text =
      'Do not open https://docs.google.com/document/d/DeniedDoc123456/edit; open https://docs.google.com/document/d/AllowedDoc123456/edit';
    const call = makeApprovedCall('docs.get', { documentId: 'AllowedDoc123456' });
    const prior = await repositories.execution.load(
      call.ctx(text).agentId,
      call.ctx(text).taskId,
      call.callId,
    );
    if (!prior) throw new Error('missing synthetic call');
    vi.spyOn(repositories.execution, 'findReceiptByIdempotencyKey').mockResolvedValue({
      id: randomUUID(),
      agentId: prior.task.agentId,
      taskId: prior.task.id,
      toolCallId: call.callId,
      modelToolCallIdHash: null,
      idempotencyKeyHash: null,
      toolName: 'docs.get',
      effectOutcome: 'completed',
      recordedAt: new Date(),
    });
    expect(await dispatch(text, 'docs.get', { documentId: 'AllowedDoc123456' })).toMatchObject({
      kind: 'rejected',
    });
    expect(docsRead).not.toHaveBeenCalled();
  });

  it('binds coordinated bare URL prohibitions with either or both', async () => {
    for (const quantifier of ['either', 'both']) {
      const { dispatch, docsRead } = fixture();
      const text = `Do not open ${quantifier} https://docs.google.com/document/d/DeniedDoc123456/edit or https://docs.google.com/document/d/OtherDenied123456/edit; open https://docs.google.com/document/d/AllowedDoc123456/edit`;
      for (const documentId of ['DeniedDoc123456', 'OtherDenied123456']) {
        expect(await dispatch(text, 'docs.get', { documentId })).toMatchObject({
          kind: 'rejected',
        });
      }
      expect(docsRead).not.toHaveBeenCalled();
      expect(await dispatch(text, 'docs.get', { documentId: 'AllowedDoc123456' })).toMatchObject({
        kind: 'executed',
      });
      expect(docsRead).toHaveBeenCalledOnce();
    }
  });

  it('honors a direct URL prohibition after an adjacent colon', async () => {
    const { dispatch, docsRead } = fixture();
    const text =
      'Do not open:https://docs.google.com/document/d/DeniedDoc123456/edit; open https://docs.google.com/document/d/AllowedDoc123456/edit';
    expect(await dispatch(text, 'docs.get', { documentId: 'DeniedDoc123456' })).toMatchObject({
      kind: 'rejected',
    });
    expect(docsRead).not.toHaveBeenCalled();
    expect(await dispatch(text, 'docs.get', { documentId: 'AllowedDoc123456' })).toMatchObject({
      kind: 'executed',
    });
    expect(docsRead).toHaveBeenCalledOnce();
  });

  it('keeps a direct Google Doc read available when it is not prohibited', async () => {
    const { dispatch, docsRead } = fixture();
    expect(await dispatch('Open this Google Doc.', 'docs.get')).toMatchObject({ kind: 'executed' });
    expect(docsRead).toHaveBeenCalledOnce();
  });

  it('does not treat a quoted no-read instruction as the owner’s prohibition', async () => {
    const { dispatch, read } = fixture();
    expect(
      await dispatch('Explain this sentence: “Don’t read Gmail.”', 'gmail.search'),
    ).toMatchObject({ kind: 'executed' });
    expect(read).toHaveBeenCalledOnce();
  });

  it('blocks only the prohibited source when the owner allows another private source', async () => {
    const { dispatch, read, calendarRead } = fixture();
    expect(
      await dispatch(
        'Do not read my calendar; search Gmail for the invoice.',
        'calendar.list_events',
      ),
    ).toMatchObject({ kind: 'rejected' });
    expect(calendarRead).not.toHaveBeenCalled();

    expect(
      await dispatch('Do not read my calendar; search Gmail for the invoice.', 'gmail.search'),
    ).toMatchObject({ kind: 'executed' });
    expect(read).toHaveBeenCalledOnce();
  });

  it.each([
    ['Do not search my Gmail; define labels.', 'gmail.search'],
    ['Never access my inbox; define labels.', 'gmail.search'],
    ['Don’t search in Gmail; explain labels.', 'gmail.search'],
    ['Do not look in my inbox; explain labels.', 'gmail.search'],
  ])('blocks explicit no-read wording: %s', async (text, toolName) => {
    const { dispatch, read } = fixture();
    expect(await dispatch(text, toolName)).toMatchObject({ kind: 'rejected' });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ['Never read emails.', 'gmail.search'],
    ['Never read calendars.', 'calendar.list_events'],
    ['Never read emails or calendars; explain the terms.', 'gmail.search'],
    ['Never read emails or calendars; explain the terms.', 'calendar.list_events'],
  ])('matches plural source names: %s', async (text, toolName) => {
    const { dispatch, read, calendarRead } = fixture();
    expect(await dispatch(text, toolName)).toMatchObject({ kind: 'rejected' });
    expect(read).not.toHaveBeenCalled();
    expect(calendarRead).not.toHaveBeenCalled();
  });

  it('uses only unquoted owner-authored prohibitions', async () => {
    const { dispatch, read } = fixture();
    expect(
      await dispatch(
        'Read my Gmail for the invoice. The quoted note says “Don’t read Gmail.”',
        'gmail.search',
      ),
    ).toMatchObject({ kind: 'executed' });
    expect(read).toHaveBeenCalledOnce();
  });

  it('rechecks an explicit no-read request before an already-approved private read executes', async () => {
    const { makeApprovedCall, dispatcher, read } = fixture();
    const approved = makeApprovedCall('gmail.search');
    const result = await dispatcher.executeApproved(
      approved.callId,
      approved.ctx('Don’t read Gmail; answer from the text already here.'),
    );
    expect(result).toMatchObject({ kind: 'failed' });
    expect(read).not.toHaveBeenCalled();
  });

  it('executes direct send, but rejects no-send and quoted send history before tool execution', async () => {
    const { dispatch, send } = fixture();
    expect(await dispatch('Send the invoice to Jordan.', 'gmail.send')).toMatchObject({
      kind: 'executed',
    });
    expect(send).toHaveBeenCalledOnce();
    send.mockClear();

    expect(
      await dispatch('Do not send the invoice; draft it for my review.', 'gmail.send'),
    ).toMatchObject({ kind: 'rejected' });
    expect(send).not.toHaveBeenCalled();

    expect(
      await dispatch(
        'Please explain this vendor quote: “Send the invoice to Jordan.”',
        'gmail.send',
      ),
    ).toMatchObject({ kind: 'rejected' });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('owner call and autonomy authority snapshots', () => {
  it('passes C admission provenance without manufacturing an autonomy grant; scheduled or missing provenance needs approval', async () => {
    vi.stubEnv('PHONE_CALL_TO_OWNER_GRANT_ENABLED', 'true');
    const repositories = makeRepositories();
    const task = {
      ...taskFixture({
        id: randomUUID(),
        agentId: randomUUID(),
        conversationId: randomUUID(),
        reminderId: randomUUID(),
      }),
      id: randomUUID(),
      agentId: randomUUID(),
      trigger: { source: 'chat', payload: { text: 'Call +14155550123 now.' } },
      type: 'chat_turn',
      status: 'running',
      trust: 'owner',
      lockedUntil: new Date(Date.now() + 60_000),
      leaseToken: 'synthetic-lease',
    };
    repositories.setCurrentTask(task);
    const request = {
      agentId: task.agentId,
      taskId: task.id,
      conversationId: 'chat',
      ownerMessageId: 'owner-message',
      requestHash: 'a'.repeat(64),
      clientOperationId: randomUUID(),
      taskTriggerFingerprint: phoneCallOwnerNumberReviewSourceFingerprint(task.trigger)!,
      recipientRequest: { kind: 'explicit_number' as const, recipientE164: '+14155550123' },
      ownerMessageFingerprint: 'c'.repeat(64),
    };
    repositories.execution.ownerCallRequest = vi.fn(async () => request);
    repositories.approvals.create = vi.fn(async () => ({
      approvalId: randomUUID(),
      toolCallId: randomUUID(),
      shortCode: 'A1AA',
      summary: 'Call',
    }));
    const match = {
      schemaVersion: 1,
      grantId: randomUUID(),
      recipientE164: '+14155550123',
      maxMinutes: 10,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    repositories.policies.list = vi.fn(async () => [
      {
        id: randomUUID(),
        agentId: task.agentId,
        toolName: 'phone.call',
        templateKey: 'phone.call.to_owner_number.v1',
        effect: 'allow',
        enabled: true,
        version: 1,
        match,
        createdVia: 'approval_dialog',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const provider = vi.fn(async () => ({ ok: true }));
    const registry = new ToolRegistry().register(
      {
        name: 'phone.call',
        description: 'synthetic call',
        inputSchema: z.object({
          brief: z.object({ to: z.string(), maxMinutes: z.number(), goal: z.string() }),
        }),
        risk: 'approval',
        acceptsUntrustedInput: false,
        execute: provider,
      },
      {
        outwardFacing: true,
        networkEgress: true,
        blanketAllowIneligible: true,
        scopedAllowTemplates: ['phone.call.to_owner_number.v1', 'phone.call.same_brief'],
      },
    );
    const dispatcher = new ToolDispatcher(
      {} as Db,
      registry,
      repositories.execution,
      repositories.costs,
      repositories.approvals,
      repositories.policies,
    );
    const ctx = {
      taskId: task.id,
      agentId: task.agentId,
      trust: 'owner',
      tainted: false,
      ownerIntent: extractOwnerIntent({ trust: 'owner', text: 'Call +14155550123 now.' }),
      now: () => new Date(),
      signal: new AbortController().signal,
      db: {} as Db,
      log: async () => {},
    } satisfies ToolContext;
    const input = {
      task,
      ctx,
      args: { brief: { to: match.recipientE164, maxMinutes: 8, goal: 'Discuss my appointment.' } },
      toolName: 'phone.call',
      step: 0,
      provenance: { plannerVersion: 1, promptVersion: 1, model: 'synthetic' },
    };
    expect(await dispatcher.dispatch(input)).toMatchObject({ kind: 'executed' });
    expect(repositories.started).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPhoneCallOwnerNumberGrant: expect.objectContaining({
          match,
          directOwnerRequest: request,
        }),
      }),
    );
    expect(repositories.started.mock.calls[0]?.[0].expectedOwnerAutonomyGrant).toBeUndefined();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(
      (await dispatcher.dispatch({ ...input, task: { ...task, type: 'scheduled' }, step: 1 })).kind,
    ).toBe('awaiting_approval');
    for (const text of [
      'Call Bob now.',
      'Call Bob about +14155550123.',
      'Call +14155550999 now.',
    ]) {
      const trigger = { source: 'chat', payload: { text } };
      repositories.execution.ownerCallRequest = async () => ({
        ...request,
        recipientRequest: ownerPhoneRecipientRequest(text),
        taskTriggerFingerprint: phoneCallOwnerNumberReviewSourceFingerprint(trigger)!,
      });
      expect(
        (
          await dispatcher.dispatch({
            ...input,
            task: { ...task, trigger },
            ctx: { ...ctx, ownerIntent: extractOwnerIntent({ trust: 'owner', text }) },
            step: 2,
          })
        ).kind,
      ).toBe('awaiting_approval');
    }
    reloadConfig({ PHONE_CALL_TO_OWNER_GRANT_ENABLED: 'true', OWNER_PHONE: '+14155550123' });
    const selfTrigger = { source: 'chat', payload: { text: 'Call me now.' } };
    const selfTask = { ...task, trigger: selfTrigger };
    repositories.setCurrentTask(selfTask);
    repositories.execution.ownerCallRequest = async () => ({
      ...request,
      recipientRequest: { kind: 'owner_self' as const },
      taskTriggerFingerprint: phoneCallOwnerNumberReviewSourceFingerprint(selfTrigger)!,
    });
    expect(
      (
        await dispatcher.dispatch({
          ...input,
          task: selfTask,
          ctx: {
            ...ctx,
            ownerIntent: extractOwnerIntent({ trust: 'owner', text: 'Call me now.' }),
          },
          step: 2,
        })
      ).kind,
    ).toBe('executed');
    expect(
      repositories.started.mock.calls.at(-1)?.[0].expectedPhoneCallOwnerNumberGrant
        ?.recipientAuthority,
    ).toMatchObject({ kind: 'configured_owner_phone', recipientE164: match.recipientE164 });
    reloadConfig({ PHONE_CALL_TO_OWNER_GRANT_ENABLED: 'true', OWNER_PHONE: '+14155550999' });
    expect(
      (
        await dispatcher.dispatch({
          ...input,
          task: selfTask,
          ctx: {
            ...ctx,
            ownerIntent: extractOwnerIntent({ trust: 'owner', text: 'Call me now.' }),
          },
          step: 2,
        })
      ).kind,
    ).toBe('awaiting_approval');
    // Even a matching saved exact brief and an active autonomy grant cannot
    // execute an ambiguous target; only the exact proposal may be approved.
    expect(
      policyTemplates['phone.call.same_brief']?.({ brief: input.args.brief }, input.args, ctx),
    ).toBe(true);
    const savedCPolicies = repositories.policies.list;
    repositories.policies.list = async () => [
      {
        id: randomUUID(),
        agentId: task.agentId,
        toolName: 'phone.call',
        templateKey: 'phone.call.same_brief',
        effect: 'allow',
        enabled: true,
        version: 1,
        match: { brief: input.args.brief },
        createdVia: 'approval_dialog',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const startedBeforeReview = repositories.started.mock.calls.length;
    const claim = vi.fn(async () => {
      throw new Error('Review-only proposals cannot claim');
    });
    repositories.execution.claim = claim;
    for (const text of [
      'Call Bob now.',
      'Call Monday.',
      'Phone Success.',
      'Call me at my other number.',
    ]) {
      const trigger = { source: 'chat', payload: { text } };
      const proposalTask = {
        ...task,
        trigger,
        autonomyGrant: {
          grantedAt: new Date(Date.now() - 1000).toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          revokedAt: null,
          grantedVia: 'composer' as const,
        },
      };
      repositories.setCurrentTask(proposalTask);
      repositories.execution.ownerCallRequest = async () => ({
        ...request,
        recipientRequest: ownerPhoneRecipientRequest(text),
        taskTriggerFingerprint: phoneCallOwnerNumberReviewSourceFingerprint(trigger)!,
      });
      expect(
        (
          await dispatcher.dispatch({
            ...input,
            task: proposalTask,
            ctx: { ...ctx, ownerIntent: extractOwnerIntent({ trust: 'owner', text }) },
            step: 5,
          })
        ).kind,
      ).toBe('awaiting_approval');
    }
    expect(repositories.started.mock.calls.length).toBe(startedBeforeReview);
    expect(claim).not.toHaveBeenCalled();
    repositories.policies.list = savedCPolicies;
    for (const text of [
      'Call me now. Actually, do not call me.',
      'Call +14155550123, but do not call me.',
      'Call it done.',
      'Call it a day.',
      'Call this a success.',
      'Phone it in.',
      'Summarize "Call me now."',
    ]) {
      const trigger = { source: 'chat', payload: { text } };
      repositories.execution.ownerCallRequest = async () => ({
        ...request,
        recipientRequest: ownerPhoneRecipientRequest(text),
        taskTriggerFingerprint: phoneCallOwnerNumberReviewSourceFingerprint(trigger)!,
      });
      expect(
        (
          await dispatcher.dispatch({
            ...input,
            task: { ...task, trigger },
            ctx: { ...ctx, ownerIntent: extractOwnerIntent({ trust: 'owner', text }) },
            step: 6,
          })
        ).kind,
      ).toBe('rejected');
    }
    const tailCases = [
      'Call +14155550123 now, or don’t.',
      'Call me now, or don’t.',
      'Call me about lunch, but use +14155550999 instead.',
      'Call +14155550123 about lunch, but use +14155550999 instead.',
      'Call me. Actually, no call is needed.',
      'Call +14155550123. Actually, no call is needed.',
      "My note says 'I want you to call me now.'",
      'If I am home, I want you to call me now.',
      'Call me now, perhaps later.',
      'Call +14155550123 now, perhaps later.',
      'Call me and say "hello".',
      'Call me about lunch. Forget that request.',
      'Call me about lunch, Disregard that request.',
      'Call me about lunch\nI changed my mind.',
      'Call me about lunch\r\nForget that request.',
      'Call me about lunch; Disregard that request.',
      'Call +14155550123 about lunch. Disregard that request.',
      'Call +14155550123 about lunch, I changed my mind.',
      'Call +14155550123 about lunch\nForget that request.',
      'Call +14155550123 about lunch\r\nDisregard that request.',
      'Call +14155550123 about lunch; I changed my mind.',
      'Call me and say hello. I changed my mind.',
      'Call me and say hello, Forget that request.',
      'Call me and say hello\nDisregard that request.',
      'Call me and say hello\r\nI changed my mind.',
      'Call me and say hello; Forget that request.',
      'Call +14155550123 and say hello. Forget that request.',
      'Call +14155550123 and say hello, Disregard that request.',
      'Call +14155550123 and say hello\nI changed my mind.',
      'Call +14155550123 and say hello\r\nForget that request.',
      'Call +14155550123 and say hello; Disregard that request.',
      'Call me about lunch. Disregard that request.',
      'Call +14155550123 about lunch. Forget that request.',
      'Call me about lunch. I changed my mind.',
      'Call me about lunch and disregard that request.',
      'Call +14155550123 about lunch then forget that request.',
      'Call me and say hello and forget that request.',
      'Call +14155550123 and say hello so I changed my mind.',
      'Call me about lunch & disregard that request.',
      'Call me about lunch..',
      'Call +14155550123 and say hello!!',
      'Call me\nat +14155550123.',
      'Call me now,\r\non +14155550123.',
      'Call\nme about lunch.',
    ];
    const startsBeforeTailCases = repositories.started.mock.calls.length;
    const basePolicy = (await savedCPolicies(task.agentId, { toolName: 'phone.call' }))[0]!;
    for (const templateKey of [
      'phone.call.same_brief',
      'phone.call.to_owner_number.v1',
      'task-autonomy',
    ]) {
      repositories.policies.list = async () =>
        templateKey === 'task-autonomy'
          ? []
          : [
              {
                ...basePolicy,
                templateKey,
                match:
                  templateKey === 'phone.call.same_brief' ? { brief: input.args.brief } : match,
              },
            ];
      for (const text of tailCases) {
        const trigger = { source: 'chat', payload: { text } };
        const sourceTask = {
          ...task,
          trigger,
          autonomyGrant: {
            grantedAt: new Date(Date.now() - 1000).toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            revokedAt: null,
            grantedVia: 'composer' as const,
          },
        };
        repositories.setCurrentTask(sourceTask);
        repositories.execution.ownerCallRequest = async () => ({
          ...request,
          recipientRequest: ownerPhoneRecipientRequest(text),
          taskTriggerFingerprint: phoneCallOwnerNumberReviewSourceFingerprint(trigger)!,
        });
        expect(
          (
            await dispatcher.dispatch({
              ...input,
              task: sourceTask,
              ctx: { ...ctx, ownerIntent: extractOwnerIntent({ trust: 'owner', text }) },
              step: 7,
            })
          ).kind,
          templateKey + ': ' + text,
        ).toBe('rejected');
      }
    }
    for (const mode of [
      'phone.call.same_brief',
      'phone.call.to_owner_number.v1',
      'task-autonomy',
    ]) {
      repositories.policies.list = async () =>
        mode === 'task-autonomy'
          ? []
          : [
              {
                ...basePolicy,
                templateKey: mode,
                match: mode === 'phone.call.same_brief' ? { brief: input.args.brief } : match,
              },
            ];
      for (const [text, expectedKind] of [
        ['Call me about lunch.', 'awaiting_approval'],
        ['Call +14155550123 about lunch.', 'awaiting_approval'],
        ['Call me and say hello.', 'awaiting_approval'],
        ['Call +14155550123 and say hello.', 'awaiting_approval'],
        ['Read the note, then call +14155550123 now.', 'awaiting_approval'],
        ['Call me about lunch disregard that request', 'rejected'],
        ['Call +14155550123 about lunch forget that request', 'rejected'],
        ['Call me and say hello I changed my mind', 'rejected'],
        ['Call +14155550123 and say hello forget that request', 'rejected'],
      ] as const) {
        const trigger = { source: 'chat', payload: { text } };
        const semanticTask = {
          ...task,
          trigger,
          autonomyGrant: {
            grantedAt: new Date(Date.now() - 1000).toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            revokedAt: null,
            grantedVia: 'composer' as const,
          },
        };
        repositories.setCurrentTask(semanticTask);
        repositories.execution.ownerCallRequest = async () => ({
          ...request,
          recipientRequest: ownerPhoneRecipientRequest(text),
          taskTriggerFingerprint: phoneCallOwnerNumberReviewSourceFingerprint(trigger)!,
        });
        expect(
          (
            await dispatcher.dispatch({
              ...input,
              task: semanticTask,
              ctx: { ...ctx, ownerIntent: extractOwnerIntent({ trust: 'owner', text }) },
              step: 9,
            })
          ).kind,
          mode + ': ' + text,
        ).toBe(expectedKind);
      }
      for (const text of [
        'Call me disregard that request',
        'Call +14155550123 forget that request',
        'Call \u2028me now',
        'Call me \u2029now',
      ]) {
        const trigger = { source: 'chat', payload: { text } };
        repositories.execution.ownerCallRequest = async () => ({
          ...request,
          recipientRequest: ownerPhoneRecipientRequest(text),
          taskTriggerFingerprint: phoneCallOwnerNumberReviewSourceFingerprint(trigger)!,
        });
        expect(
          (
            await dispatcher.dispatch({
              ...input,
              task: { ...task, trigger },
              ctx: { ...ctx, ownerIntent: extractOwnerIntent({ trust: 'owner', text }) },
              step: 10,
            })
          ).kind,
        ).toBe('rejected');
      }
    }
    expect(repositories.started.mock.calls.length).toBe(startsBeforeTailCases);
    expect(claim).not.toHaveBeenCalled();
    repositories.policies.list = savedCPolicies;
    resetConfigForTest();
    repositories.setCurrentTask(task);
    const nonCallTrigger = { source: 'chat', payload: { text: 'Email Bob now.' } };
    repositories.execution.ownerCallRequest = async () => ({
      ...request,
      taskTriggerFingerprint: phoneCallOwnerNumberReviewSourceFingerprint(nonCallTrigger)!,
    });
    expect(
      (await dispatcher.dispatch({ ...input, task: { ...task, trigger: nonCallTrigger }, step: 2 }))
        .kind,
    ).toBe('awaiting_approval');
    repositories.execution.ownerCallRequest = async () => null;
    expect((await dispatcher.dispatch({ ...input, step: 2 })).kind).toBe('awaiting_approval');
    expect(
      (await dispatcher.dispatch({ ...input, step: 3, ctx: { ...ctx, tainted: true } })).kind,
    ).toBe('awaiting_approval');
    expect(provider).toHaveBeenCalledTimes(2);
    for (const text of [
      'Email Bob now.',
      'Text Bob now.',
      'Apply for the job.',
      'Call it done.',
      'Call it a day.',
      'Call this a success.',
      'Dial back the wording.',
      'Phone it in.',
    ]) {
      const result = await dispatcher.dispatch({
        ...input,
        step: 4,
        ctx: { ...ctx, ownerIntent: extractOwnerIntent({ trust: 'owner', text }) },
      });
      expect(result).toMatchObject({ kind: 'rejected' });
      expect(result.kind === 'rejected' && result.reason).toContain('phone_call');
    }
    // Once that exact proposal is explicitly approved, the ordinary recorded-
    // approval path remains usable without a saved C or autonomy dependency.
    for (const namedText of ['Call Bob now.', 'Call me about lunch.']) {
      const approvedTask = { ...task, trigger: { source: 'chat', payload: { text: namedText } } };
      const approvedCall = toolCallRow({
        agentId: task.agentId,
        taskId: task.id,
        step: 8,
        toolName: 'phone.call',
        args: input.args,
        idempotencyKey: null,
        decision: {},
      });
      approvedCall.status = 'approved';
      approvedCall.approvalId = randomUUID();
      const approval: Records['approvals'] = {
        id: approvedCall.approvalId,
        taskId: task.id,
        toolCallId: approvedCall.id,
        status: 'approved',
        expiresAt: new Date(Date.now() + 60_000),
        resolvedAt: new Date(),
        requestedAt: new Date(),
        summary: 'Explicitly reviewed named call',
        shortCode: 'A1AA',
        payload: input.args,
        resolutionPayload: null,
        resolvedVia: 'web',
        notifiedChannels: [],
        createdPolicyId: null,
      };
      repositories.setApprovedCall(approvedTask, approvedCall, approval);
      const explicitClaim = vi.fn(
        async (_input: Parameters<ToolExecutionRepository['claim']>[0]) => ({
          task: approvedTask,
          toolCall: { ...approvedCall, status: 'executing' as const },
          approval,
        }),
      );
      repositories.execution.claim = explicitClaim;
      expect(
        await dispatcher.executeApproved(approvedCall.id, {
          ...ctx,
          ownerIntent: extractOwnerIntent({ trust: 'owner', text: namedText }),
        }),
      ).toMatchObject({ kind: 'executed' });
      expect(explicitClaim).toHaveBeenCalledWith(
        expect.objectContaining({ expectedApprovalId: approval.id }),
      );
      expect(explicitClaim.mock.calls[0]?.[0]).not.toHaveProperty(
        'expectedPhoneCallOwnerNumberGrant',
      );
    }
    expect(provider).toHaveBeenCalledTimes(4);
  });

  it('binds v2 call authority to the current owner action and keeps unavailable quotes on approval', async () => {
    vi.stubEnv('PHONE_CALL_TO_OWNER_GRANT_ENABLED', 'true');
    const repositories = makeRepositories();
    const text = 'Call +14155550123 about rescheduling my appointment.';
    expect(ownerPhoneRecipientRequest(text)).toBeNull();
    expect(ownerPhoneProposalNeedsApproval(text)).toBe(true);
    const trigger = { source: 'chat', payload: { text } };
    const task = {
      ...taskFixture({
        id: randomUUID(),
        agentId: randomUUID(),
        conversationId: randomUUID(),
        reminderId: randomUUID(),
      }),
      id: randomUUID(),
      agentId: randomUUID(),
      trigger,
      type: 'chat_turn',
      status: 'running',
      trust: 'owner',
      lockedUntil: new Date(Date.now() + 60_000),
      leaseToken: 'synthetic-lease',
    };
    repositories.setCurrentTask(task);
    const request = {
      agentId: task.agentId,
      taskId: task.id,
      conversationId: 'chat',
      ownerMessageId: 'owner-message',
      requestHash: 'a'.repeat(64),
      clientOperationId: randomUUID(),
      taskTriggerFingerprint: phoneCallOwnerNumberReviewSourceFingerprint(trigger)!,
      recipientRequest: null,
      ownerMessageFingerprint: 'c'.repeat(64),
    };
    repositories.execution.ownerCallRequest = vi.fn(async () => request);
    const match = {
      schemaVersion: 2,
      grantId: randomUUID(),
      action: 'phone.call',
      recipientE164: '+14155550123',
      maxMinutes: 10,
      maxCallsPerHour: 2,
      maxCallsPerDay: 4,
      maxCostUsdMicrosPerCall: 500_000,
      maxCostUsdMicrosPerDay: 1_000_000,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    repositories.policies.list = vi.fn(async () => [
      {
        id: randomUUID(),
        agentId: task.agentId,
        toolName: 'phone.call',
        templateKey: 'phone.call.owner_action.v2',
        effect: 'allow',
        enabled: true,
        version: 1,
        match,
        createdVia: 'approval_dialog',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const provider = vi.fn(async () => ({ ok: true }));
    let quote: number | null = 125_000;
    const quoteOwnerCallCostUsdMicros = vi.fn(async () => quote);
    const registry = new ToolRegistry().register(
      {
        name: 'phone.call',
        description: 'synthetic call',
        inputSchema: z.object({
          brief: z.object({ to: z.string(), maxMinutes: z.number(), goal: z.string() }),
        }),
        risk: 'approval',
        acceptsUntrustedInput: false,
        quoteOwnerCallCostUsdMicros,
        execute: provider,
      },
      {
        outwardFacing: true,
        networkEgress: true,
        blanketAllowIneligible: true,
        scopedAllowTemplates: ['phone.call.owner_action.v2'],
      },
    );
    const dispatcher = new ToolDispatcher(
      {} as Db,
      registry,
      repositories.execution,
      repositories.costs,
      repositories.approvals,
      repositories.policies,
    );
    const ctx = {
      taskId: task.id,
      agentId: task.agentId,
      trust: 'owner',
      tainted: false,
      ownerIntent: extractOwnerIntent({ trust: 'owner', text }),
      now: () => new Date(),
      signal: new AbortController().signal,
      db: {} as Db,
      log: async () => {},
    } satisfies ToolContext;
    const input = {
      task,
      ctx,
      args: { brief: { to: '+14155550123', maxMinutes: 8, goal: 'Reschedule my appointment.' } },
      toolName: 'phone.call',
      step: 0,
      provenance: { plannerVersion: 1, promptVersion: 1, model: 'synthetic' },
    };

    expect(await dispatcher.dispatch(input)).toMatchObject({ kind: 'executed' });
    expect(repositories.started).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPhoneCallOwnerActionGrant: expect.objectContaining({
          match,
          directOwnerRequest: request,
          estimatedCostUsdMicros: 125_000,
          ownerActionIntent: {
            intent: {
              action: 'phone.call',
              recipientRequest: { kind: 'explicit_number', recipientE164: '+14155550123' },
            },
            ownerMessageFingerprint: request.ownerMessageFingerprint,
          },
        }),
      }),
    );
    quote = null;
    repositories.approvals.create = vi.fn(async () => ({
      approvalId: randomUUID(),
      toolCallId: randomUUID(),
      shortCode: 'A2AA',
      summary: 'Call',
    }));
    expect(await dispatcher.dispatch({ ...input, step: 1 })).toMatchObject({
      kind: 'awaiting_approval',
    });

    const startedBeforeWithdrawal = repositories.started.mock.calls.length;
    const withdrawnText = 'Call +14155550123 about lunch, I changed my mind.';
    const withdrawnTrigger = { source: 'chat', payload: { text: withdrawnText } };
    const withdrawnTask = { ...task, trigger: withdrawnTrigger };
    repositories.setCurrentTask(withdrawnTask);
    repositories.execution.ownerCallRequest = vi.fn(async () => ({
      ...request,
      taskTriggerFingerprint: phoneCallOwnerNumberReviewSourceFingerprint(withdrawnTrigger)!,
    }));
    expect(
      await dispatcher.dispatch({
        ...input,
        task: withdrawnTask,
        ctx: {
          ...ctx,
          ownerIntent: extractOwnerIntent({ trust: 'owner', text: withdrawnText }),
        },
        step: 2,
      }),
    ).toMatchObject({ kind: 'rejected' });
    expect(repositories.started).toHaveBeenCalledTimes(startedBeforeWithdrawal);
    expect(provider).toHaveBeenCalledTimes(1);
    repositories.setCurrentTask(task);
    repositories.execution.ownerCallRequest = vi.fn(async () => request);

    quote = 125_000;
    const directText = 'Call +14155550123, now.';
    const directTrigger = { source: 'chat', payload: { text: directText } };
    const directTask = { ...task, trigger: directTrigger };
    const directRequest = {
      ...request,
      recipientRequest: { kind: 'explicit_number' as const, recipientE164: '+14155550123' },
      taskTriggerFingerprint: phoneCallOwnerNumberReviewSourceFingerprint(directTrigger)!,
    };
    repositories.setCurrentTask(directTask);
    repositories.execution.ownerCallRequest = vi.fn(async () => directRequest);
    expect(
      await dispatcher.dispatch({
        ...input,
        task: directTask,
        ctx: { ...ctx, ownerIntent: extractOwnerIntent({ trust: 'owner', text: directText }) },
        step: 3,
      }),
    ).toMatchObject({ kind: 'executed' });
    expect(provider).toHaveBeenCalledTimes(2);

    for (const unrelatedText of [
      'Please summarize this note: "Call +14155550123 about lunch."',
      'Email Bob instead.',
      'Call it a day.',
    ]) {
      const unrelatedTrigger = { source: 'chat', payload: { text: unrelatedText } };
      const unrelatedTask = { ...task, trigger: unrelatedTrigger };
      repositories.setCurrentTask(unrelatedTask);
      repositories.execution.ownerCallRequest = vi.fn(async () => ({
        ...request,
        taskTriggerFingerprint: phoneCallOwnerNumberReviewSourceFingerprint(unrelatedTrigger)!,
      }));
      const result = await dispatcher.dispatch({
        ...input,
        task: unrelatedTask,
        ctx: {
          ...ctx,
          ownerIntent: extractOwnerIntent({ trust: 'owner', text: unrelatedText }),
        },
        step: 4,
      });
      expect(result).toMatchObject({ kind: 'rejected' });
      expect(result.kind === 'rejected' && result.reason).not.toContain('ambiguous or withdrawn');
    }
    expect(provider).toHaveBeenCalledTimes(2);
    repositories.setCurrentTask(task);
    repositories.execution.ownerCallRequest = vi.fn(async () => request);
    quote = null;

    repositories.approvals.create = vi.fn(async () => ({
      approvalId: randomUUID(),
      toolCallId: randomUUID(),
      shortCode: 'A3AA',
      summary: 'Call',
    }));
    const legacyPolicies = [
      {
        id: randomUUID(),
        agentId: task.agentId,
        toolName: 'phone.call',
        templateKey: 'phone.call.to_owner_number.v1',
        effect: 'allow',
        enabled: true,
        version: 1,
        match: {
          schemaVersion: 1,
          grantId: randomUUID(),
          recipientE164: '+14155550123',
          maxMinutes: 10,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        createdVia: 'approval_dialog',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: randomUUID(),
        agentId: task.agentId,
        toolName: 'phone.call',
        templateKey: 'phone.call.same_brief',
        effect: 'allow',
        enabled: true,
        version: 1,
        match: { brief: input.args.brief },
        createdVia: 'approval_dialog',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: randomUUID(),
        agentId: task.agentId,
        toolName: 'phone.call',
        templateKey: 'phone.call.owner_action.v2',
        effect: 'allow',
        enabled: true,
        version: 1,
        match,
        createdVia: 'approval_dialog',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    repositories.policies.list = vi.fn(async () => legacyPolicies);
    const beforeLegacyWithdrawal = repositories.started.mock.calls.length;
    const withdrawalPolicySets = [
      [legacyPolicies[0]!],
      [legacyPolicies[1]!],
      [legacyPolicies[2]!],
      legacyPolicies,
    ];
    const unsafeOwnerTexts = [
      withdrawnText,
      'Call +14155550123 about lunch. Actually, email Bob instead.',
    ];
    for (const [policyIndex, rows] of withdrawalPolicySets.entries()) {
      repositories.policies.list = vi.fn(async () => rows);
      for (const [textIndex, unsafeText] of unsafeOwnerTexts.entries()) {
        const unsafeTrigger = { source: 'chat', payload: { text: unsafeText } };
        const unsafeTask = { ...task, trigger: unsafeTrigger };
        repositories.setCurrentTask(unsafeTask);
        repositories.execution.ownerCallRequest = vi.fn(async () => ({
          ...request,
          taskTriggerFingerprint: phoneCallOwnerNumberReviewSourceFingerprint(unsafeTrigger)!,
        }));
        expect(
          await dispatcher.dispatch({
            ...input,
            task: unsafeTask,
            ctx: {
              ...ctx,
              ownerIntent: extractOwnerIntent({ trust: 'owner', text: unsafeText }),
            },
            step: 3 + policyIndex * unsafeOwnerTexts.length + textIndex,
          }),
        ).toMatchObject({ kind: 'rejected' });
      }
    }
    expect(repositories.started).toHaveBeenCalledTimes(beforeLegacyWithdrawal);
    repositories.setCurrentTask(task);
    repositories.execution.ownerCallRequest = vi.fn(async () => request);
    repositories.policies.list = vi.fn(async () => legacyPolicies);
    expect(await dispatcher.dispatch({ ...input, step: 2 })).toMatchObject({
      kind: 'awaiting_approval',
    });
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('fails withdrawn approved calls before reserve or claim but preserves a direct exact request', async () => {
    const repositories = makeRepositories();
    const provider = vi.fn(async () => ({ ok: true }));
    const registry = new ToolRegistry().register(
      {
        name: 'phone.call',
        description: 'synthetic call',
        inputSchema: z.object({
          brief: z.object({ to: z.string(), maxMinutes: z.number(), goal: z.string() }),
        }),
        risk: 'approval',
        acceptsUntrustedInput: false,
        execute: provider,
      },
      { outwardFacing: true, networkEgress: true },
    );
    const dispatcher = new ToolDispatcher(
      {} as Db,
      registry,
      repositories.execution,
      repositories.costs,
      repositories.approvals,
      repositories.policies,
    );
    const makeApproved = (trigger: unknown) => {
      const task = {
        ...taskFixture({
          id: randomUUID(),
          agentId: randomUUID(),
          conversationId: randomUUID(),
          reminderId: randomUUID(),
        }),
        id: randomUUID(),
        agentId: randomUUID(),
        trigger,
        type: 'chat_turn',
        status: 'running',
        trust: 'owner',
        lockedUntil: new Date(Date.now() + 60_000),
        leaseToken: 'approved-call-lease',
      };
      const call = toolCallRow({
        agentId: task.agentId,
        taskId: task.id,
        step: 0,
        toolName: 'phone.call',
        args: { brief: { to: '+14155550123', maxMinutes: 5, goal: 'Discuss my appointment.' } },
        idempotencyKey: null,
        decision: {},
      });
      call.status = 'approved';
      const approvalId = randomUUID();
      call.approvalId = approvalId;
      const approval: Records['approvals'] = {
        id: approvalId,
        taskId: task.id,
        toolCallId: call.id,
        status: 'approved',
        expiresAt: new Date(Date.now() + 60_000),
        resolvedAt: new Date(),
        requestedAt: new Date(),
        summary: 'Reviewed call',
        shortCode: 'A4AA',
        payload: call.args,
        resolutionPayload: null,
        resolvedVia: 'web',
        notifiedChannels: [],
        createdPolicyId: null,
      };
      repositories.setApprovedCall(task, call, approval);
      return { task, call, approval };
    };
    const reserve = vi.fn(repositories.costs.reserve);
    repositories.costs.reserve = reserve;
    const claim = vi.fn(repositories.execution.claim);
    repositories.execution.claim = claim;
    const withdrawnText = 'Call +14155550123 about lunch, I changed my mind.';
    const withdrawnTrigger = { source: 'chat', payload: { text: withdrawnText } };
    const withdrawn = makeApproved(withdrawnTrigger);
    const withdrawnResult = await dispatcher.executeApproved(withdrawn.call.id, {
      taskId: withdrawn.task.id,
      agentId: withdrawn.task.agentId,
      trust: 'owner',
      tainted: false,
      ownerIntent: extractOwnerIntent({ trust: 'owner', text: withdrawnText }),
      now: () => new Date(),
      signal: new AbortController().signal,
      db: {} as Db,
      log: async () => {},
    } satisfies ToolContext);
    expect(withdrawnResult).toMatchObject({ kind: 'failed' });
    expect(reserve).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(repositories.outcome).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: withdrawn.call.id,
        status: 'failed',
        fromStatus: 'approved',
      }),
    );

    const changedTopicText = 'Call +14155550123 about lunch. Actually, email Bob instead.';
    const changedTopic = makeApproved({
      source: 'chat',
      payload: { text: changedTopicText },
    });
    expect(
      await dispatcher.executeApproved(changedTopic.call.id, {
        taskId: changedTopic.task.id,
        agentId: changedTopic.task.agentId,
        trust: 'owner',
        tainted: false,
        ownerIntent: extractOwnerIntent({ trust: 'owner', text: changedTopicText }),
        now: () => new Date(),
        signal: new AbortController().signal,
        db: {} as Db,
        log: async () => {},
      }),
    ).toMatchObject({ kind: 'failed' });
    expect(reserve).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();

    const directText = 'Call +14155550123, now.';
    const directTrigger = { source: 'chat', payload: { text: directText } };
    const direct = makeApproved(directTrigger);
    repositories.execution.claim = vi.fn(async () => ({
      task: direct.task,
      toolCall: { ...direct.call, status: 'executing' },
      approval: direct.approval,
    }));
    expect(
      await dispatcher.executeApproved(direct.call.id, {
        taskId: direct.task.id,
        agentId: direct.task.agentId,
        trust: 'owner',
        tainted: false,
        ownerIntent: extractOwnerIntent({ trust: 'owner', text: directText }),
        now: () => new Date(),
        signal: new AbortController().signal,
        db: {} as Db,
        log: async () => {},
      }),
    ).toMatchObject({ kind: 'executed', result: { ok: true } });
    expect(provider).toHaveBeenCalledTimes(1);

    const topicText = 'Call +14155550123 about the bus stop.';
    const topic = makeApproved({ source: 'chat', payload: { text: topicText } });
    expect(
      await dispatcher.executeApproved(topic.call.id, {
        taskId: topic.task.id,
        agentId: topic.task.agentId,
        trust: 'owner',
        tainted: false,
        ownerIntent: extractOwnerIntent({ trust: 'owner', text: topicText }),
        now: () => new Date(),
        signal: new AbortController().signal,
        db: {} as Db,
        log: async () => {},
      }),
    ).toMatchObject({ kind: 'executed', result: { ok: true } });
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('captures the canonical actual owner autonomy grant only when it changes the risk decision', async () => {
    const repositories = makeRepositories();
    const grant = {
      grantedAt: new Date(Date.now() - 1_000).toISOString(),
      grantedVia: 'composer' as const,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      revokedAt: null,
    };
    const task = {
      ...taskFixture({
        id: randomUUID(),
        agentId: randomUUID(),
        conversationId: randomUUID(),
        reminderId: randomUUID(),
      }),
      id: randomUUID(),
      agentId: randomUUID(),
      type: 'chat_turn',
      status: 'running',
      trust: 'owner',
      lockedUntil: new Date(Date.now() + 60_000),
      leaseToken: 'synthetic-lease',
      autonomyGrant: grant,
    };
    repositories.setCurrentTask(task);
    const registry = new ToolRegistry().register(
      {
        name: 'test.outward',
        description: 'synthetic effect',
        inputSchema: z.object({}),
        risk: 'approval',
        acceptsUntrustedInput: true,
        execute: async () => ({ ok: true }),
      },
      { outwardFacing: true },
    );
    const dispatcher = new ToolDispatcher(
      {} as Db,
      registry,
      repositories.execution,
      repositories.costs,
      repositories.approvals,
      repositories.policies,
    );
    const ctx = {
      taskId: task.id,
      agentId: task.agentId,
      trust: 'owner',
      tainted: false,
      ownerIntent: extractOwnerIntent({ trust: 'owner', text: 'Send a message now.' }),
      now: () => new Date(),
      signal: new AbortController().signal,
      db: {} as Db,
      log: async () => {},
    } satisfies ToolContext;
    expect(
      await dispatcher.dispatch({
        task,
        ctx,
        args: {},
        toolName: 'test.outward',
        step: 0,
        provenance: { plannerVersion: 1, promptVersion: 1, model: 'synthetic' },
      }),
    ).toMatchObject({ kind: 'executed' });
    expect(repositories.started).toHaveBeenCalledWith(
      expect.objectContaining({ expectedOwnerAutonomyGrant: { trust: 'owner', grant } }),
    );
  });
});

it('a phone request grants no Gmail, SMS, or calendar-invitation authority', async () => {
  const f = fixture();
  for (const name of ['sms.send', 'calendar.create_event'])
    f.registry.register(
      {
        name,
        description: 'synthetic outward tool',
        inputSchema: z.object({}),
        risk: 'autonomous',
        acceptsUntrustedInput: true,
        execute: f.send,
      },
      { outwardFacing: true, networkEgress: true },
    );
  for (const tool of ['gmail.send', 'sms.send', 'calendar.create_event']) {
    const result = await f.dispatch('Call me now.', tool);
    expect(result.kind).toBe('rejected');
    expect(result.kind === 'rejected' && result.reason).toContain('external_send');
  }
  expect(f.send).not.toHaveBeenCalled();
});
