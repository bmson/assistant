import { randomUUID } from 'node:crypto';
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
import { taskFixture } from '@assistant/persistence/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolDispatcher } from './dispatcher.js';
import { ToolRegistry } from './registry.js';
import type { ToolContext } from './types.js';

function toolCallRow(input: StartAutonomousToolCallInput): Records['toolCalls'] {
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
  const started = vi.fn(async (input: StartAutonomousToolCallInput) => toolCallRow(input));
  const outcome = vi.fn(async () => true);
  const contacts = vi.fn(async () => [] as Array<{ emails: string[]; phones: string[] }>);
  const execution: ToolExecutionRepository = {
    kind: 'tool-execution-repository',
    load: async () =>
      approvedCall && approvedTask
        ? { toolCall: approvedCall, task: approvedTask, approval: approvedApproval }
        : null,
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
    list: async () => [],
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
    lockedUntil: new Date(Date.now() + 60_000),
  };
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
    makeApprovedCall,
    dispatcher,
    read,
    send,
    calendarRead,
    docsRead,
    driveRead,
    sheetsRead,
    repositories,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('P03 owner intent at ToolDispatcher boundary (synthetic repositories only)', () => {
  it('executes the direct authorized Gmail read positive control', async () => {
    const { dispatch, read } = fixture();
    expect(await dispatch('Read my Gmail for the invoice.', 'gmail.search')).toMatchObject({
      kind: 'executed',
    });
    expect(read).toHaveBeenCalledOnce();
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
