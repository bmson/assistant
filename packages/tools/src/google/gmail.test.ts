import {
  buildReadToolInput,
  detectPersonalReadRequest,
  type ReadToolEvidence,
} from '@assistant/core/workflow/read-intent';
import { gmailSearchReceiptSourceId } from '@assistant/persistence/gmail-search-identity';
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import type { ToolContext } from '../types.js';
import { registerGmailTools } from './gmail.js';

const outbound = {
  to: ['person@example.com'],
  subject: 'Research summary',
  body: 'Quoted public-web findings',
  register: 'email_professional' as const,
};

function context(tainted: boolean): ToolContext {
  return {
    taskId: 'task-1',
    agentId: 'agent-1',
    trust: 'owner',
    tainted,
    db: {} as ToolContext['db'],
    now: () => new Date(),
    signal: new AbortController().signal,
    log: async () => {},
  };
}

describe('gmail.read_thread receive time', () => {
  it('exposes provider receive time separately from the editable Date header', async () => {
    const api = vi.fn().mockResolvedValue({
      messages: [
        {
          id: 'message-1',
          threadId: 'thread-1',
          internalDate: '1791531760567',
          payload: {
            mimeType: 'text/plain',
            headers: [{ name: 'Date', value: 'Mon, 01 Jan 2001 00:00:00 +0000' }],
            body: { data: Buffer.from('Your invoice').toString('base64url') },
          },
        },
      ],
    });
    const read = registerGmailTools(new ToolRegistry(), {
      client: { api } as never,
      botEmail: 'bot@example.com',
    }).get('gmail.read_thread')?.tool;
    const result = (await read?.execute({ threadId: 'thread-1' }, {} as never)) as {
      messages: Array<{ date: string; receivedAt: string }>;
    };
    expect(result.messages[0]).toMatchObject({
      date: 'Mon, 01 Jan 2001 00:00:00 +0000',
      receivedAt: '2026-10-09T07:42:40.567Z',
    });
  });
});

describe('gmail.search', () => {
  it.each([
    'Find my next trip from my booking emails and calendar. Confirm the flight dates, departure times and time zones, connections, and hotel. Check for conflicting information. Then plan how to get from the destination airport to my hotel, comparing public transport and taxi. Give me a short itinerary with source links, and clearly mark anything you cannot verify.',
    'Find my next trip using my booking emails and calendar. Verify the flight dates, departure times, connections and hotel, then compare public transport and taxi from the arrival airport to the hotel with source links and unresolved details.',
  ])(
    'accepts both generated trip search queries and sends them unchanged to Gmail',
    async (prompt) => {
      const request = detectPersonalReadRequest([{ role: 'user', content: prompt }]);
      expect(request?.compoundTripDiscovery).toBe(true);
      if (!request?.mailQueries) throw new Error('Expected compound trip mail queries');
      const api = vi.fn().mockResolvedValue({ messages: [], resultSizeEstimate: 0 });
      const tool = registerGmailTools(new ToolRegistry(), {
        client: { api } as never,
        botEmail: 'bot@example.com',
      }).get('gmail.search')?.tool;
      if (!tool) throw new Error('Expected Gmail search tool');
      const flightInput = buildReadToolInput(request, 'gmail.search', []);
      const first = tool.inputSchema.parse(flightInput) as { query: string; maxResults: number };
      expect(first.query).toBe(request.mailQueries[0]?.query);
      expect(first.query.length).toBeLessThanOrEqual(1024);
      await tool.execute(first, {} as never);
      const flightEvidence: ReadToolEvidence = {
        toolName: 'gmail.search',
        status: 'succeeded',
        fromCurrentTask: true,
        args: first,
        result: { query: first.query, complete: true, hasMore: false, results: [] },
      };
      const lodgingInput = buildReadToolInput(request, 'gmail.search', [flightEvidence]);
      const second = tool.inputSchema.parse(lodgingInput) as { query: string; maxResults: number };
      expect(second.query).toBe(request.mailQueries[1]?.query);
      expect(second.query.length).toBeGreaterThan(300);
      expect(second.query.length).toBeLessThanOrEqual(1024);
      await tool.execute(second, {} as never);
      expect(api).toHaveBeenCalledTimes(2);
      expect(new URL(api.mock.calls[0]?.[0] as string).searchParams.get('q')).toBe(first.query);
      expect(new URL(api.mock.calls[1]?.[0] as string).searchParams.get('q')).toBe(second.query);
      expect(
        (tool.inputSchema.parse({ query: 'x'.repeat(1024), maxResults: 1 }) as { query: string })
          .query,
      ).toHaveLength(1024);
      expect(() => tool.inputSchema.parse({ query: 'x'.repeat(1025), maxResults: 1 })).toThrow();
    },
  );

  it('accepts a bounded 100-result metadata page and rejects larger requests', () => {
    const tool = registerGmailTools(new ToolRegistry(), {
      client: { api: vi.fn() } as never,
      botEmail: 'bot@example.com',
    }).get('gmail.search')?.tool;
    expect(
      tool?.inputSchema.parse({ query: 'newer_than:7d -from:me', maxResults: 100 }),
    ).toMatchObject({
      maxResults: 100,
    });
    expect(() =>
      tool?.inputSchema.parse({ query: 'newer_than:7d -from:me', maxResults: 101 }),
    ).toThrow();
  });

  it('keeps long valid searches and continuation queries intact with bounded stable source IDs', async () => {
    const api = vi.fn().mockResolvedValue({
      messages: [],
      nextPageToken: 'next-page',
      resultSizeEstimate: 1,
    });
    const tool = registerGmailTools(new ToolRegistry(), {
      client: { api } as never,
      botEmail: 'bot@example.com',
    }).get('gmail.search')?.tool;
    expect(tool).toBeDefined();
    const query = 'x'.repeat(300);
    const read = async (value: string, pageToken?: string) =>
      tool?.execute(
        tool.inputSchema.parse({ query: value, maxResults: 1, pageToken }),
        {} as never,
      ) as Promise<{
        query: string;
        receipt: { source: { id: string }; continuation: { input: { query: string } } };
      }>;
    const first = await read(query);
    const second = await read(query, 'next-page');
    const different = await read(`${'x'.repeat(299)}y`);
    expect(first.query).toBe(query);
    expect(first.receipt.source.id).toBe(gmailSearchReceiptSourceId(query));
    expect(first.receipt.source.id).toMatch(/^query-sha256:[a-f0-9]{64}$/);
    expect(second.receipt.source.id).toBe(first.receipt.source.id);
    expect(different.receipt.source.id).not.toBe(first.receipt.source.id);
    expect(first.receipt.continuation.input.query).toBe(query);
    expect(second.receipt.continuation.input.query).toBe(query);
    for (const call of api.mock.calls.slice(0, 2))
      expect(new URL(call[0] as string).searchParams.get('q')).toBe(query);
    expect(new URL(api.mock.calls[1]?.[0] as string).searchParams.get('pageToken')).toBe(
      'next-page',
    );
    expect((await read('x'.repeat(256))).receipt.source.id).toBe('x'.repeat(256));
    expect((await read('x'.repeat(257))).receipt.source.id.length).toBeLessThanOrEqual(256);
    expect(() => tool?.inputSchema.parse({ query: 'x'.repeat(1025), maxResults: 1 })).toThrow();
  });

  it('searches all mail and marks a capped result set as partial', async () => {
    const api = vi.fn(async (url: string) => {
      if (url.includes('/messages?')) {
        return {
          messages: [{ id: 'message-1' }],
          nextPageToken: 'another-page',
          resultSizeEstimate: 4,
        };
      }
      return {
        id: 'message-1',
        threadId: 'thread-1',
        snippet: 'Clay interview details',
      };
    });
    const result = (await registerGmailTools(new ToolRegistry(), {
      client: { api } as never,
      botEmail: 'bot@example.com',
      ownerEmail: 'Owner@Example.com',
    })
      .get('gmail.search')
      ?.tool.execute({ query: 'Clay', maxResults: 1 }, {} as never)) as {
      complete: boolean;
      mailboxSearched: string;
      configuredOwnerMailbox?: string;
      matchingMessagesEstimate?: number;
      receipt: { continuation: { tool: string; input: { pageToken: string } } | null };
    };

    expect(api.mock.calls[0]?.[0]).not.toContain('in%3Ainbox');
    expect(result).toMatchObject({
      complete: false,
      mailboxSearched: 'bot@example.com',
      configuredOwnerMailbox: 'owner@example.com',
      matchingMessagesEstimate: 4,
      coverage: { requested: 1, discovered: 4, returned: 1, hasMore: true },
      nextPageToken: 'another-page',
    });
    expect(result.receipt.continuation).toEqual({
      tool: 'gmail.search',
      input: { query: 'Clay', maxResults: 1, pageToken: 'another-page' },
    });
  });

  it('resumes with Gmail page tokens and keeps inaccessible metadata in coverage', async () => {
    const api = vi.fn(async (url: string) => {
      if (url.includes('/messages?')) {
        expect(url).toContain('pageToken=next-page');
        return { messages: [{ id: 'message-2' }], resultSizeEstimate: 2 };
      }
      throw new Error('metadata unavailable');
    });
    const result = (await registerGmailTools(new ToolRegistry(), {
      client: { api } as never,
      botEmail: 'bot@example.com',
    })
      .get('gmail.search')
      ?.tool.execute(
        { query: 'current trip', maxResults: 1, pageToken: 'next-page' },
        {} as never,
      )) as {
      complete: boolean;
      unavailable: Array<{ messageId: string }>;
      coverage: { returned: number; unavailable: number };
    };

    expect(api.mock.calls[0]?.[0]).toContain('pageToken=next-page');
    expect(result).toMatchObject({
      complete: false,
      unavailable: [{ messageId: 'message-2' }],
      coverage: { returned: 0, unavailable: 1 },
    });
  });

  it('does not mark a truncated thread body complete', async () => {
    const api = vi.fn().mockResolvedValue({
      messages: [
        {
          id: 'message-1',
          payload: {
            mimeType: 'text/plain',
            body: { data: Buffer.from('x'.repeat(8_001)).toString('base64url') },
          },
        },
      ],
    });
    const result = (await registerGmailTools(new ToolRegistry(), {
      client: { api } as never,
      botEmail: 'bot@example.com',
    })
      .get('gmail.read_thread')
      ?.tool.execute({ threadId: 'thread-1' }, {} as never)) as {
      complete: boolean;
      coverage: { complete: boolean };
      messages: Array<{ truncated: boolean }>;
    };

    expect(result).toMatchObject({
      complete: false,
      coverage: { complete: false },
      messages: [{ truncated: true }],
    });
  });

  it('continues at the exact bounded message-body offset to retrieve decisive tail text', async () => {
    const fullText = `${'x'.repeat(8_000)}DECISIVE source detail`;
    const api = vi.fn().mockResolvedValue({
      messages: [
        {
          id: 'message-1',
          threadId: 'thread-1',
          payload: {
            mimeType: 'text/plain',
            body: { data: Buffer.from(fullText).toString('base64url') },
          },
        },
      ],
    });
    const read = registerGmailTools(new ToolRegistry(), {
      client: { api } as never,
      botEmail: 'bot@example.com',
    }).get('gmail.read_thread')?.tool;
    const first = (await read?.execute({ threadId: 'thread-1' }, {} as never)) as {
      messages: Array<{ text: string; truncated: boolean }>;
      receipt: {
        complete: boolean;
        continuation: { tool: string; input: Record<string, unknown> } | null;
      };
    };
    expect(first.messages[0]?.text).toHaveLength(8_000);
    expect(first.messages[0]?.truncated).toBe(true);
    expect(first.receipt.complete).toBe(false);
    const continuation = first.receipt.continuation;
    expect(continuation).toMatchObject({
      tool: 'gmail.read_thread',
      input: { threadId: 'thread-1', startMessageIndex: 0, startMessageOffset: 8_000 },
    });
    const second = (await read?.execute(continuation?.input as never, {} as never)) as {
      complete: boolean;
      messages: Array<{ text: string; truncated: boolean }>;
      receipt: { complete: boolean; continuation: unknown };
    };
    expect(second.messages[0]?.text).toContain('DECISIVE source detail');
    expect(second.messages[0]?.truncated).toBe(false);
    expect(second.complete).toBe(true);
    expect(second.receipt).toMatchObject({ complete: true, continuation: null });
  });

  it('finishes a truncated message before reading the later owner reply', async () => {
    const firstBody = `${'x'.repeat(8_000)}${'tail-'.repeat(400)}`;
    const ownerReply = 'Owner reply: I can confirm the revised date.';
    const api = vi.fn().mockResolvedValue({
      messages: [
        {
          id: 'message-request',
          threadId: 'thread-1',
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'From', value: 'sender@example.com' },
              { name: 'Subject', value: 'Please review the date' },
            ],
            body: { data: Buffer.from(firstBody).toString('base64url') },
          },
        },
        {
          id: 'message-owner-reply',
          threadId: 'thread-1',
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'From', value: 'owner@example.com' },
              { name: 'Subject', value: 'Re: Please review the date' },
            ],
            body: { data: Buffer.from(ownerReply).toString('base64url') },
          },
        },
      ],
    });
    const read = registerGmailTools(new ToolRegistry(), {
      client: { api } as never,
      botEmail: 'bot@example.com',
    }).get('gmail.read_thread')?.tool;

    const first = (await read?.execute({ threadId: 'thread-1' }, {} as never)) as {
      messages: Array<{ messageId: string; text: string; truncated: boolean }>;
      complete: boolean;
      hasMore: boolean;
      receipt: { continuation: { input: Record<string, unknown> } | null };
    };
    expect(first.messages.map(({ messageId, truncated }) => ({ messageId, truncated }))).toEqual([
      { messageId: 'message-request', truncated: true },
    ]);
    expect(first).toMatchObject({ complete: false, hasMore: true });
    expect(first.receipt.continuation?.input).toMatchObject({
      startMessageIndex: 0,
      startMessageOffset: 8_000,
    });

    const second = (await read?.execute(
      first.receipt.continuation?.input as never,
      {} as never,
    )) as {
      messages: Array<{ messageId: string; text: string; truncated: boolean }>;
      complete: boolean;
      hasMore: boolean;
      receipt: { continuation: unknown };
    };
    expect(second.messages.map(({ messageId }) => messageId)).toEqual([
      'message-request',
      'message-owner-reply',
    ]);
    expect(second.messages[0]).toMatchObject({
      text: firstBody.slice(8_000),
      truncated: false,
    });
    expect(second.messages[1]).toMatchObject({ text: ownerReply, truncated: false });
    expect(second).toMatchObject({
      complete: true,
      hasMore: false,
      receipt: { continuation: null },
    });

    const reconstructed = new Map<string, string>();
    for (const message of [...first.messages, ...second.messages]) {
      reconstructed.set(
        message.messageId,
        `${reconstructed.get(message.messageId) ?? ''}${message.text}`,
      );
    }
    expect([...reconstructed]).toEqual([
      ['message-request', firstBody],
      ['message-owner-reply', ownerReply],
    ]);
  });

  it('keeps the whole-page character limit before continuing to the next message', async () => {
    const api = vi.fn().mockResolvedValue({
      messages: ['x'.repeat(100), 'owner reply'].map((text, index) => ({
        id: `message-${index}`,
        threadId: 'thread-1',
        payload: {
          mimeType: 'text/plain',
          body: { data: Buffer.from(text).toString('base64url') },
        },
      })),
    });
    const read = registerGmailTools(new ToolRegistry(), {
      client: { api } as never,
      botEmail: 'bot@example.com',
    }).get('gmail.read_thread')?.tool;

    const first = (await read?.execute({ threadId: 'thread-1', maxChars: 100 }, {} as never)) as {
      messages: Array<{ messageId: string; text: string }>;
      hasMore: boolean;
      receipt: { continuation: { input: Record<string, unknown> } | null };
    };
    expect(first.messages.map((message) => message.messageId)).toEqual(['message-0']);
    expect(first.messages[0]?.text).toHaveLength(100);
    expect(first.hasMore).toBe(true);
    expect(first.receipt.continuation?.input).toMatchObject({
      startMessageIndex: 1,
      startMessageOffset: 0,
    });

    const second = (await read?.execute(
      first.receipt.continuation?.input as never,
      {} as never,
    )) as {
      messages: Array<{ messageId: string; text: string }>;
      complete: boolean;
    };
    expect(second.messages).toEqual([
      {
        messageId: 'message-1',
        text: 'owner reply',
        from: '',
        to: '',
        date: '',
        subject: '',
        truncated: false,
        sourceLength: 11,
      },
    ]);
    expect(second.complete).toBe(true);
  });

  it('continues to later thread messages when the requested message page is full', async () => {
    const api = vi.fn().mockResolvedValue({
      messages: ['one', 'two', 'decisive third'].map((text, index) => ({
        id: `message-${index}`,
        threadId: 'thread-1',
        payload: {
          mimeType: 'text/plain',
          body: { data: Buffer.from(text).toString('base64url') },
        },
      })),
    });
    const read = registerGmailTools(new ToolRegistry(), {
      client: { api } as never,
      botEmail: 'bot@example.com',
    }).get('gmail.read_thread')?.tool;
    const first = (await read?.execute({ threadId: 'thread-1', maxMessages: 2 }, {} as never)) as {
      messages: Array<{ text: string }>;
      receipt: { continuation: { input: Record<string, unknown> } | null };
    };
    expect(first.messages.map((message) => message.text)).toEqual(['one', 'two']);
    expect(first.receipt.continuation?.input).toMatchObject({ startMessageIndex: 2 });
    const second = (await read?.execute(
      first.receipt.continuation?.input as never,
      {} as never,
    )) as {
      complete: boolean;
      messages: Array<{ text: string }>;
    };
    expect(second.messages[0]?.text).toBe('decisive third');
    expect(second.complete).toBe(true);
  });
});

describe('Gmail outbound security', () => {
  it('allows owner-led external-content email only through an outward approval boundary', () => {
    const registry = registerGmailTools(new ToolRegistry(), {
      client: {} as never,
      botEmail: 'bot@example.com',
    });
    const registered = registry.get('gmail.send');

    expect(registered?.tool.acceptsUntrustedInput).toBe(true);
    expect(registered?.tool.risk).toBe('approval');
    expect(registered?.flags).toMatchObject({
      outwardFacing: true,
      networkEgress: true,
      blanketAllowIneligible: true,
    });
    expect(registry.toolsForTask('unknown').map((tool) => tool.name)).not.toContain('gmail.send');
    expect(registry.toolsForTask('owner').map((tool) => tool.name)).toContain('gmail.send');
  });

  it('never sends tainted content through the private voice-rewrite context', async () => {
    const prepareOutbound = vi.fn(async () => ({ text: 'voice rewritten' }));
    const registry = registerGmailTools(new ToolRegistry(), {
      client: {} as never,
      botEmail: 'bot@example.com',
      prepareOutbound,
    });
    const prepare = registry.get('gmail.send')?.tool.prepare;
    expect(prepare).toBeDefined();
    if (!prepare) return;

    await expect(prepare(outbound, context(true))).resolves.toEqual(outbound);
    expect(prepareOutbound).not.toHaveBeenCalled();

    await expect(prepare(outbound, context(false))).resolves.toMatchObject({
      body: 'voice rewritten',
    });
    expect(prepareOutbound).toHaveBeenCalledOnce();
  });

  it('attaches an allowlisted workspace file and rejects a disallowed path', async () => {
    const api = vi.fn().mockResolvedValue({ id: 'sent-1', threadId: 't-1' });
    const readBytes = vi.fn(async () => Buffer.from('CSVDATA'));
    const registry = registerGmailTools(new ToolRegistry(), {
      client: { api } as unknown as never,
      botEmail: 'bot@example.com',
      workspace: { readBytes },
    });
    const send = registry.get('gmail.send')?.tool;

    await send?.execute(
      { ...outbound, attachments: [{ workspacePath: 'code/task-1/out.csv' }] },
      context(false),
    );
    expect(readBytes).toHaveBeenCalledWith('code/task-1/out.csv');
    const [, init] = api.mock.calls[0] as [string, RequestInit];
    const raw = JSON.parse(String(init.body)).raw as string;
    expect(Buffer.from(raw, 'base64url').toString('utf8')).toContain('filename="out.csv"');

    await expect(
      send?.execute(
        { ...outbound, attachments: [{ workspacePath: 'b-bot/browser/profile.tar.enc' }] },
        context(false),
      ),
    ).rejects.toThrow(/not allowed/);
  });

  it('names attachments on the send approval card', () => {
    const summary = registerGmailTools(new ToolRegistry(), {
      client: {} as never,
      botEmail: 'bot@example.com',
    })
      .get('gmail.send')
      ?.tool.approvalSummary?.({
        ...outbound,
        attachments: [{ workspacePath: 'code/t/chart.png' }],
      });
    expect(summary).toContain('chart.png');
  });

  it('keys create_draft idempotently: stable for the same draft, distinct for a different body', () => {
    const key = registerGmailTools(new ToolRegistry(), {
      client: {} as never,
      botEmail: 'bot@example.com',
    }).get('gmail.create_draft')?.tool.idempotencyKey;
    expect(key).toBeDefined();
    if (!key) return;
    const ctx = context(false);
    expect(key(outbound, ctx)).toBe(key(outbound, ctx));
    expect(key(outbound, ctx)).not.toBe(key({ ...outbound, body: 'different' }, ctx));
  });
});

describe('gmail.modify', () => {
  function modifyTool(api = vi.fn()) {
    return registerGmailTools(new ToolRegistry(), {
      client: { api } as unknown as never,
      botEmail: 'bot@example.com',
    }).get('gmail.modify');
  }

  it('is autonomous for labels/mark-read and approval for archive', () => {
    const risk = modifyTool()?.tool.risk;
    expect(typeof risk).toBe('function');
    if (typeof risk !== 'function') return;
    const ctx = context(false);
    expect(risk({ threadId: 't', addLabels: [], removeLabels: [], archive: false }, ctx)).toBe(
      'autonomous',
    );
    expect(risk({ threadId: 't', addLabels: [], removeLabels: [], archive: true }, ctx)).toBe(
      'approval',
    );
    expect(modifyTool()?.flags).toMatchObject({ privateWrite: true });
  });

  it('translates markRead and archive into label mutations on the bot mailbox', async () => {
    const api = vi.fn().mockResolvedValue({});
    await modifyTool(api)?.tool.execute(
      {
        threadId: 'thread-9',
        addLabels: ['Waiting'],
        removeLabels: [],
        markRead: true,
        archive: true,
      },
      {} as never,
    );
    const [url, init] = api.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/threads/thread-9/modify');
    expect(JSON.parse(String(init.body))).toEqual({
      addLabelIds: ['Waiting'],
      removeLabelIds: ['UNREAD', 'INBOX'],
    });
  });

  it('reviews equivalent archive and consequential system-label mutations consistently', () => {
    const tool = modifyTool()?.tool;
    if (!tool || typeof tool.risk !== 'function') throw new Error('missing label risk function');
    for (const labels of [
      { removeLabels: ['INBOX'] },
      { addLabels: ['TRASH'] },
      { removeLabels: ['SPAM'] },
      { addLabels: ['INBOX'] },
      { addLabels: ['SENT'] },
    ]) {
      const args = tool.inputSchema.parse({ threadId: 't', archive: false, ...labels });
      expect(tool.risk(args, context(false))).toBe('approval');
    }
    const ordinary = tool.inputSchema.parse({
      threadId: 't',
      addLabels: ['Label_123'],
      markRead: true,
    });
    expect(tool.risk(ordinary, context(false))).toBe('autonomous');
  });

  it('rejects contradictory effective label operations, including convenience conversions', () => {
    const schema = modifyTool()?.tool.inputSchema;
    expect(schema?.safeParse({ threadId: 't', addLabels: ['INBOX'], archive: true }).success).toBe(
      false,
    );
    expect(
      schema?.safeParse({ threadId: 't', addLabels: ['UNREAD'], markRead: true }).success,
    ).toBe(false);
    expect(
      schema?.safeParse({ threadId: 't', addLabels: ['Label_123'], removeLabels: ['Label_123'] })
        .success,
    ).toBe(false);
  });
});
