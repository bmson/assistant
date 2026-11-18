import { createHash, randomUUID } from 'node:crypto';
import type { ToolExecutionRepository } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { ToolContext } from '../types.js';
import {
  type PersonalCalendarReadAccount,
  registerAccountAwareCalendarTools,
} from './calendar-connection.js';
import { AmbiguousGoogleMutationError, GoogleApiError, GoogleClient } from './client.js';
import { PartialGoogleArtifactError } from './effect-progress.js';

function fixture() {
  const personal = new GoogleClient({
    clientId: 'personal',
    clientSecret: 'personal',
    refreshToken: 'private-test',
  });
  const legacy = new GoogleClient({
    clientId: 'assistant',
    clientSecret: 'assistant',
    refreshToken: 'private-test',
  });
  const legacyApi = vi.spyOn(legacy, 'api').mockResolvedValue({ id: 'legacy' });
  const account: PersonalCalendarReadAccount = {
    client: personal,
    subject: 'sub',
    email: 'owner@example.com',
    connectionId: randomUUID(),
    calendarWrite: true,
  };
  let current: PersonalCalendarReadAccount | null = account;
  let event: Record<string, unknown> | undefined;
  let loseResponse = false,
    failRead = false,
    rejectPost = false;
  const api = vi.spyOn(personal, 'api').mockImplementation(async (url, init) => {
    if (url.includes('/users/me/calendarList/'))
      return {
        id: 'stable-calendar@example.com',
        summary: 'Personal',
        accessRole: 'owner',
      } as never;
    if (init?.method === 'POST') {
      if (rejectPost) throw new GoogleApiError(403, 'forbidden', url);
      event = {
        ...JSON.parse(String(init.body)),
        status: 'confirmed',
        htmlLink: 'https://calendar.google.com/calendar/event?eid=example',
      };
      if (loseResponse) throw new AmbiguousGoogleMutationError('lost response');
      return structuredClone(event) as never;
    }
    if (failRead) throw new GoogleApiError(503, 'unavailable', url);
    if (!event) throw new GoogleApiError(404, 'notFound', url);
    return structuredClone(event) as never;
  });
  const taskId = randomUUID(),
    callId = randomUUID();
  const checkpoint = vi.fn(async (_progress: unknown) => {});
  const context = {
    taskId,
    agentId: 'owner',
    signal: new AbortController().signal,
    execution: {
      dbToolCallId: callId,
      toolName: 'calendar.create_event',
      modelToolCallId: 'operation',
    },
    checkpointExternalEffect: checkpoint,
  } as unknown as ToolContext;
  let stored: unknown;
  const load = vi.fn(async () => stored) as unknown as ToolExecutionRepository['load'];
  const execution = { load } as ToolExecutionRepository;
  const registry = new ToolRegistry();
  const personalAccount = vi.fn(async () => current);
  registerAccountAwareCalendarTools(registry, {
    client: legacy,
    botEmail: 'assistant@example.com',
    ownerEmail: 'owner@example.com',
    personalAccount,
    creationExecution: execution,
  });
  const tool = registry.get('calendar.create_event')!.tool;
  const reconcile = registry.get('calendar.reconcile_event_creation')!.tool;
  const input = {
    account: 'personal',
    calendarId: 'primary',
    summary: 'Approved meeting',
    start: '2026-11-20T10:00:00-08:00',
    end: '2026-11-20T11:00:00-08:00',
  };
  async function prepare(extra = {}) {
    return (await tool.prepareSecurity!(
      tool.inputSchema.parse({ ...input, ...extra }),
      context,
      'dispatch',
    )) as Record<string, unknown>;
  }
  return {
    tool,
    reconcile,
    registry,
    context,
    checkpoint,
    api,
    legacyApi,
    account,
    personalAccount,
    input,
    prepare,
    replaceAccount: (next: PersonalCalendarReadAccount | null) => {
      current = next;
    },
    lose: () => {
      loseResponse = true;
    },
    unavailable: () => {
      failRead = true;
    },
    available: () => {
      failRead = false;
    },
    reject: () => {
      rejectPost = true;
    },
    editEvent: (change: Record<string, unknown>) => {
      event = { ...event, ...change };
    },
    persist: (args: unknown, status = 'executing', approved = true) => {
      stored = {
        toolCall: {
          id: callId,
          taskId,
          toolName: 'calendar.create_event',
          args,
          status,
          decision: {
            externalEffect: {
              ...(checkpoint.mock.calls.at(-1)?.[0] as object),
              payloadDigest: createHash('sha256').update(JSON.stringify(args)).digest('hex'),
            },
          },
        },
        approval: { status: approved ? 'approved' : 'denied' },
      };
    },
  };
}

describe('approved personal Calendar creation', () => {
  it('binds explicit account/calendar and every detail before approval, including no-attendee events', async () => {
    const f = fixture();
    const args = await f.prepare();
    expect(args.calendarId).toBe('stable-calendar@example.com');
    expect(typeof f.tool.risk === 'function' && f.tool.risk(args, f.context)).toBe('approval');
    expect(f.tool.approvalSummary?.(args)).toContain('owner@example.com');
    expect(f.tool.approvalSummary?.(args)).toContain('Personal');
    expect(f.tool.approvalSummary?.(args)).toContain('2026-11-20T10:00:00-08:00');
    expect(f.api.mock.calls.every(([, init]) => !init?.method)).toBe(true);
    expect(
      f.registry.get('calendar.create_event')!.flags.ownerVisibleOnly instanceof Function &&
        (
          f.registry.get('calendar.create_event')!.flags.ownerVisibleOnly as (a: unknown) => boolean
        )(args),
    ).toBe(false);
    await expect(f.tool.prepareSecurity!(args, f.context, 'approved')).resolves.toEqual(args);
    for (const change of [
      { summary: 'Edited' },
      { end: '2026-11-21T11:00:00-08:00' },
      { calendarId: 'other' },
      { attendees: ['other@example.com'] },
    ])
      await expect(
        f.tool.prepareSecurity!({ ...args, ...change }, f.context, 'approved'),
      ).rejects.toThrow('changed');
    expect(f.legacyApi).not.toHaveBeenCalled();
  });
  it('rejects forged model bindings and missing write access, destination or valid time', async () => {
    const f = fixture();
    const valid = await f.prepare();
    const stripped = f.tool.inputSchema.parse({
      ...f.input,
      _approvalCalendarScope: valid._approvalCalendarScope,
    });
    await expect(f.tool.prepareSecurity!(stripped, f.context, 'approved')).rejects.toThrow(
      'binding',
    );
    await expect(f.prepare({ calendarId: undefined })).rejects.toThrow('Select');
    await expect(f.prepare({ end: f.input.start })).rejects.toThrow('after');
    await expect(f.prepare({ attendees: ['a@example.com', 'A@example.com'] })).rejects.toThrow(
      'unique',
    );
    f.account.calendarWrite = false;
    await expect(f.prepare()).rejects.toThrow('event-write');
    expect(f.legacyApi).not.toHaveBeenCalled();
  });
  it('refuses identity/reconnect/disconnect changes without any assistant fallback', async () => {
    for (const field of ['connectionId', 'subject', 'email', 'disconnected']) {
      const f = fixture();
      const args = await f.prepare();
      f.api.mockClear();
      f.replaceAccount(
        field === 'disconnected'
          ? null
          : {
              ...f.account,
              [field]: field === 'connectionId' ? randomUUID() : 'different@example.com',
            },
      );
      await expect(f.tool.execute(args, f.context)).rejects.toThrow();
      expect(f.api).not.toHaveBeenCalled();
      expect(f.legacyApi).not.toHaveBeenCalled();
    }
  });
  it('checkpoints before one POST and requires same-operation canonical readback', async () => {
    const f = fixture();
    const args = await f.prepare({ attendees: ['guest@example.com'] });
    f.api.mockClear();
    const order: string[] = [];
    f.checkpoint.mockImplementation(async (value) => {
      order.push((value as { stage: string }).stage);
    });
    const result = await f.tool.execute(args, f.context);
    expect(result).toMatchObject({
      effectStatus: 'completed',
      sameOperationReadback: true,
      invited: ['guest@example.com'],
      calendarId: 'stable-calendar@example.com',
      calendarAccount: { connectionId: f.account.connectionId },
      toolCallId: f.context.execution?.dbToolCallId,
    });
    expect(order).toEqual(['prepared', 'created', 'verified']);
    expect(f.api.mock.calls).toHaveLength(2);
    const [url, init] = f.api.mock.calls[0]!;
    const body = JSON.parse(String(init?.body));
    expect(url).toContain('/calendars/stable-calendar%40example.com/events?sendUpdates=all');
    expect(body.id).toMatch(/^[a-v0-9]{34}$/);
    expect(f.api.mock.calls[1]?.[0]).toContain('/events/' + body.id);
    expect(f.checkpoint.mock.invocationCallOrder[0]).toBeLessThan(
      f.api.mock.invocationCallOrder[0]!,
    );
    expect(f.legacyApi).not.toHaveBeenCalled();
  });
  it('preserves the existing booking-currentness guard before every personal create', async () => {
    const f = fixture();
    const args = await f.prepare();
    f.api.mockClear();
    const guard = vi.fn(async () => false);
    const ctx = {
      ...f.context,
      bookingOccurrence: { agentId: 'owner', bookingKey: 'mail-booking', version: 1 },
      assertBookingOccurrenceCurrent: guard,
    };
    await expect(f.tool.execute(args, ctx)).rejects.toThrow('booking changed');
    expect(guard).toHaveBeenCalledOnce();
    expect(f.api).not.toHaveBeenCalled();
    expect(f.checkpoint).not.toHaveBeenCalled();
    guard.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(f.tool.execute(args, ctx)).rejects.toThrow('booking changed');
    expect(f.api).not.toHaveBeenCalled();
  });
  it('never POSTs if the durable checkpoint cannot be retained', async () => {
    const f = fixture();
    const args = await f.prepare();
    f.api.mockClear();
    f.checkpoint.mockRejectedValue(Error('storage unavailable'));
    await expect(f.tool.execute(args, f.context)).rejects.toThrow('storage');
    expect(f.api).not.toHaveBeenCalled();
  });
  it('recovers a lost POST response by GET of the fixed event, without another POST', async () => {
    const f = fixture();
    const args = await f.prepare();
    f.api.mockClear();
    f.lose();
    expect(await f.tool.execute(args, f.context)).toMatchObject({
      effectStatus: 'completed',
      sameOperationReadback: true,
    });
    expect(f.api.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('retains uncertain outcome then reconciles the original operation across restart/read-only downgrade', async () => {
    const f = fixture();
    const args = await f.prepare();
    f.api.mockClear();
    f.lose();
    f.unavailable();
    await expect(f.tool.execute(args, f.context)).rejects.toBeInstanceOf(
      PartialGoogleArtifactError,
    );
    f.persist(JSON.parse(JSON.stringify(args)));
    f.account.calendarWrite = false;
    const keys = { taskId: f.context.taskId, toolCallId: f.context.execution!.dbToolCallId };
    expect(await f.reconcile.execute(keys, f.context)).toMatchObject({
      effectStatus: 'unknown',
      retrySuppressed: true,
    });
    f.available();
    const result = await f.reconcile.execute(keys, f.context);
    expect(result).toMatchObject({
      effectStatus: 'completed',
      sameOperationReadback: true,
      originalTaskId: f.context.taskId,
    });
    expect(f.api.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('does not treat a missing or changed canonical event as completed or retry it', async () => {
    const f = fixture();
    const args = await f.prepare();
    f.lose();
    f.unavailable();
    await expect(f.tool.execute(args, f.context)).rejects.toBeInstanceOf(
      PartialGoogleArtifactError,
    );
    f.persist(args);
    f.available();
    f.editEvent({ summary: 'unrelated' });
    expect(
      await f.reconcile.execute(
        { taskId: f.context.taskId, toolCallId: f.context.execution!.dbToolCallId },
        f.context,
      ),
    ).toMatchObject({ effectStatus: 'unknown' });
    expect(f.api.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('does not reconcile denied or foreign/uncheckpointed operations', async () => {
    const f = fixture();
    const args = await f.prepare();
    f.persist(args, 'denied', false);
    f.api.mockClear();
    await expect(
      f.reconcile.execute(
        { taskId: f.context.taskId, toolCallId: f.context.execution!.dbToolCallId },
        f.context,
      ),
    ).rejects.toThrow('not found');
    f.persist(args);
    await expect(
      f.reconcile.execute(
        { taskId: f.context.taskId, toolCallId: f.context.execution!.dbToolCallId },
        f.context,
      ),
    ).rejects.toThrow('checkpointed');
    expect(f.api).not.toHaveBeenCalled();
  });
  it('definitive provider rejection remains failed without readback, retry or fallback', async () => {
    const f = fixture();
    const args = await f.prepare();
    f.api.mockClear();
    f.reject();
    await expect(f.tool.execute(args, f.context)).rejects.toBeInstanceOf(GoogleApiError);
    expect(f.api).toHaveBeenCalledOnce();
    expect(f.legacyApi).not.toHaveBeenCalled();
  });
  it('keeps assistant creation default and its existing policy behavior', async () => {
    const f = fixture();
    const args = f.tool.inputSchema.parse({
      ...f.input,
      account: undefined,
      calendarId: undefined,
    });
    expect((args as { account: string }).account).toBe('assistant');
    expect(await f.tool.execute(args, f.context)).toMatchObject({ eventId: 'legacy' });
    expect(f.legacyApi).toHaveBeenCalledOnce();
    expect(f.personalAccount).not.toHaveBeenCalled();
  });
});
