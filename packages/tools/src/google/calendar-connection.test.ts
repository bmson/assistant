import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { ToolContext } from '../types.js';
import { registerAccountAwareCalendarTools } from './calendar-connection.js';
import { GoogleClient } from './client.js';

function client(email: string) {
  const value = new GoogleClient({ clientId: 'test', clientSecret: email, refreshToken: email });
  vi.spyOn(value, 'api').mockImplementation(
    async () =>
      ({
        items: [{ id: email, summary: email, primary: true, accessRole: 'owner' }],
      }) as never,
  );
  return value;
}

const context = { agentId: 'owner-one' } as ToolContext;

function requireTool(registry: ToolRegistry, name: string) {
  const tool = registry.get(name);
  if (!tool) throw new Error(`Missing test tool: ${name}`);
  return tool;
}

function setup(
  personalAccount = vi.fn(
    async (_agentId: string) =>
      null as null | {
        client: GoogleClient;
        subject: string;
        email: string;
      },
  ),
) {
  const legacy = client('assistant@example.test');
  const registry = new ToolRegistry();
  registerAccountAwareCalendarTools(registry, {
    client: legacy,
    botEmail: 'assistant@example.test',
    ownerEmail: 'owner@example.test',
    personalAccount,
  });
  return { registry, legacy, personalAccount };
}

describe('Calendar account routing', () => {
  it('binds roster pagination to its account and reconnect generation', async () => {
    let personal = client('personal@example.test-generation-one');
    vi.mocked(personal.api).mockResolvedValue({
      items: [],
      nextPageToken: 'private-provider-cursor',
    });
    const { registry, legacy } = setup(
      vi.fn(async () => ({ client: personal, subject: 'subject', email: 'personal@example.test' })),
    );
    const read = requireTool(registry, 'calendar.list_calendars').tool;
    const first = (await read.execute({}, context)) as { nextPageToken: string };
    expect(first.nextPageToken).not.toContain('private-provider-cursor');
    await read.execute({ pageToken: first.nextPageToken }, context);
    expect(vi.mocked(personal.api).mock.calls.at(-1)?.[0]).toContain(
      'pageToken=private-provider-cursor',
    );
    await expect(
      read.execute({ account: 'assistant', pageToken: first.nextPageToken }, context),
    ).rejects.toThrow('different account');
    expect(legacy.api).not.toHaveBeenCalled();
    personal = client('personal@example.test-generation-two');
    await expect(read.execute({ pageToken: first.nextPageToken }, context)).rejects.toThrow(
      'different account',
    );
    expect(personal.api).not.toHaveBeenCalled();
  });
  it('preserves the never-connected assistant source and private-read policy', async () => {
    const { registry, legacy } = setup();
    const read = requireTool(registry, 'calendar.list_calendars');
    const result = await read.tool.execute({}, context);
    expect(result).toMatchObject({
      calendarAccount: { kind: 'assistant', email: 'assistant@example.test' },
    });
    expect(legacy.api).toHaveBeenCalledOnce();
    expect(read.flags.confidentialRead).toBe(true);
    expect(registry.toolsForTask('unknown').some((tool) => tool.name === read.tool.name)).toBe(
      false,
    );
  });

  it('uses the personal account by default and preserves the original mutation tools', async () => {
    const personal = client('personal@example.test');
    const resolve = vi.fn(async () => ({
      client: personal,
      subject: 'google-subject',
      email: 'personal@example.test',
    }));
    const { registry, legacy } = setup(resolve);
    const read = requireTool(registry, 'calendar.list_calendars');
    const result = await read.tool.execute({}, context);
    expect(resolve).toHaveBeenCalledWith('owner-one');
    expect(personal.api).toHaveBeenCalledOnce();
    expect(legacy.api).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      calendarAccount: {
        kind: 'personal',
        subject: 'google-subject',
        email: 'personal@example.test',
      },
    });
    const mutation = requireTool(registry, 'calendar.create_event').tool;
    expect(mutation.description).toContain("assistant's own calendar");
    expect(
      mutation.inputSchema.safeParse({
        summary: 'test',
        start: '2026-11-16T10:00:00Z',
        end: '2026-11-16T11:00:00Z',
        account: 'personal',
      }),
    ).toMatchObject({ success: true });
    expect(
      (
        mutation.inputSchema.parse({
          summary: 'test',
          start: '2026-11-16T10:00:00Z',
          end: '2026-11-16T11:00:00Z',
          account: 'personal',
        }) as Record<string, unknown>
      ).account,
    ).toBe('personal');
  });

  it('rejects explicit personal selectors for mutations outside the create slice', () => {
    const { registry } = setup();
    for (const name of [
      'calendar.update_event',
      'calendar.cancel_event',
      'calendar.respond_to_event',
    ]) {
      const registered = registry.get(name);
      if (!registered) continue;
      expect(
        registered.tool.inputSchema.safeParse({
          account: 'personal',
          eventId: 'event-123',
          summary: 'change',
          response: 'accepted',
        }).success,
      ).toBe(false);
    }
  });
  it('allows an explicit assistant read without querying personal credentials', async () => {
    const resolve = vi.fn(async () => {
      throw new Error('Personal account disconnected');
    });
    const { registry, legacy } = setup(resolve);
    const result = await requireTool(registry, 'calendar.list_calendars').tool.execute(
      { account: 'assistant' },
      context,
    );
    expect(result).toMatchObject({ calendarAccount: { kind: 'assistant' } });
    expect(resolve).not.toHaveBeenCalled();
    expect(legacy.api).toHaveBeenCalledOnce();
  });

  it('never substitutes the assistant account after personal access fails', async () => {
    const resolve = vi.fn(async () => {
      throw new Error('Reconnect your personal Google Calendar');
    });
    const { registry, legacy } = setup(resolve);
    for (const input of [{}, { account: 'personal' }]) {
      await expect(
        requireTool(registry, 'calendar.list_calendars').tool.execute(input, context),
      ).rejects.toThrow('Reconnect');
    }
    expect(legacy.api).not.toHaveBeenCalled();
  });

  it('does not satisfy an explicit personal read using a never-connected account', async () => {
    const { registry, legacy } = setup();
    await expect(
      requireTool(registry, 'calendar.list_calendars').tool.execute(
        { account: 'personal' },
        context,
      ),
    ).rejects.toThrow('Connect your personal');
    expect(legacy.api).not.toHaveBeenCalled();
  });

  it('registers no mutations for a personal-only Calendar installation', () => {
    const registry = new ToolRegistry();
    registerAccountAwareCalendarTools(
      registry,
      {
        client: client('assistant@example.test'),
        botEmail: '',
        ownerEmail: '',
        personalAccount: async () => null,
      },
      { readOnly: true },
    );
    expect(
      registry
        .all()
        .map(({ tool }) => tool.name)
        .sort(),
    ).toEqual([
      'calendar.availability',
      'calendar.list_calendars',
      'calendar.list_events',
      'calendar.search_events',
    ]);
  });
});
