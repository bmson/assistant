import { describe, expect, it, vi } from 'vitest';
import { type EmailSyncDeps, processMessage } from './email-sync.js';

describe('direct email observer admission', () => {
  it('rejects spoofed booking mail before card/watch composition or provider model work', async () => {
    const observeInboundEmail = vi.fn();
    const model = vi.fn();
    const notifyOwner = vi.fn();
    const inboundMessage = vi.fn().mockResolvedValue(null);
    const hasTaskForEvent = vi.fn().mockResolvedValue(false);
    const api = vi.fn().mockResolvedValue({
      id: 'spoof',
      threadId: 'thread',
      labelIds: ['INBOX'],
      payload: {
        headers: [
          { name: 'From', value: 'hotel@unverified.example' },
          { name: 'Subject', value: 'Hotel booking confirmation' },
          {
            name: 'Authentication-Results',
            value: 'mx.google.com; dmarc=fail header.from=unverified.example',
          },
        ],
        mimeType: 'text/plain',
        body: {
          data: Buffer.from('Booking confirmed at Hotel Example tomorrow').toString('base64url'),
        },
      },
    });
    const deps = {
      config: {
        EMAIL_INGEST_MODE: 'direct',
        GMAIL_SYNC_ENABLED: 'true',
        ASSISTANT_MODULES: ['google'],
      },
      persistence: { emailSync: { inboundMessage, hasTaskForEvent } },
      googleClient: { configured: () => true, api },
      router: { object: model },
      notifyOwner,
      observeInboundEmail,
      operationalReady: async () => true,
    } as unknown as EmailSyncDeps;
    const result = await processMessage(deps, 'owner', 'bot@example.test', new Map(), 'spoof');
    expect(result).toBe('skipped');
    expect(observeInboundEmail).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
    expect(notifyOwner).not.toHaveBeenCalled();
    expect(api).toHaveBeenCalledOnce();
  });

  it('holds authenticated unknown senders before application or card observers when the daily cap is full', async () => {
    const observeInboundEmail = vi.fn();
    const model = vi.fn();
    const expireDue = vi.fn();
    const triagedSince = vi.fn().mockResolvedValue(1);
    const api = vi.fn().mockResolvedValue({
      id: 'unknown-flood',
      threadId: 'thread',
      labelIds: ['INBOX'],
      payload: {
        headers: [
          { name: 'From', value: 'sender@verified.example' },
          { name: 'Subject', value: 'Hotel booking confirmation' },
          {
            name: 'Authentication-Results',
            value: 'mx.google.com; dmarc=pass header.from=verified.example',
          },
        ],
        mimeType: 'text/plain',
        body: {
          data: Buffer.from('Booking confirmed at Hotel Example tomorrow').toString('base64url'),
        },
      },
    });
    const deps = {
      config: {
        EMAIL_INGEST_MODE: 'direct',
        EMAIL_INGEST_MAX_TRIAGE_PER_DAY: 1,
        GMAIL_SYNC_ENABLED: 'true',
        ASSISTANT_MODULES: ['google'],
      },
      persistence: {
        emailSync: {
          inboundMessage: vi.fn().mockResolvedValue(null),
          hasTaskForEvent: vi.fn().mockResolvedValue(false),
          triagedSince,
        },
        applications: { expireDue },
      },
      googleClient: { configured: () => true, api },
      router: { object: model },
      notifyOwner: vi.fn(),
      observeInboundEmail,
      operationalReady: async () => true,
    } as unknown as EmailSyncDeps;

    const result = await processMessage(
      deps,
      'owner',
      'bot@example.test',
      new Map(),
      'unknown-flood',
    );

    expect(result).toBe('skipped');
    expect(triagedSince).toHaveBeenCalledOnce();
    expect(expireDue).not.toHaveBeenCalled();
    expect(observeInboundEmail).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });

  it.each([
    ['legacy', null, 1],
    ['durable', { admittedSourceKind: 'message' }, 0],
  ] as const)(
    'does not rerun paid observers or application checks for a %s persisted event replay',
    async (_kind, admitted, expectedTaskCalls) => {
      const observeInboundEmail = vi.fn();
      const model = vi.fn();
      const expireDue = vi.fn();
      const createTask = vi.fn().mockResolvedValue({
        created: false,
        task: { id: 'task-existing', status: 'done' },
      });
      const api = vi.fn().mockResolvedValue({
        id: 'replay',
        threadId: 'thread',
        labelIds: ['INBOX'],
        payload: {
          headers: [
            { name: 'From', value: 'sender@verified.example' },
            { name: 'Subject', value: 'Hotel booking confirmation' },
            {
              name: 'Authentication-Results',
              value: 'mx.google.com; dmarc=pass header.from=verified.example',
            },
          ],
          mimeType: 'text/plain',
          body: {
            data: Buffer.from('Booking confirmed at Hotel Example tomorrow').toString('base64url'),
          },
        },
      });
      const deps = {
        config: {
          EMAIL_INGEST_MODE: 'direct',
          EMAIL_INGEST_MAX_TRIAGE_PER_DAY: 10,
          GMAIL_SYNC_ENABLED: 'true',
          ASSISTANT_MODULES: ['google'],
        },
        persistence: {
          emailSync: {
            inboundMessage: vi.fn().mockResolvedValue({
              conversationId: 'conversation-existing',
              origin: 'unknown',
            }),
            hasTaskForEvent: vi.fn().mockResolvedValue(false),
            ingestRecord: vi.fn().mockResolvedValue(admitted),
          },
          tasks: { kind: 'task-lease-repository', createTask },
          applications: { expireDue },
        },
        googleClient: { configured: () => true, api },
        router: { object: model },
        notifyOwner: vi.fn(),
        observeInboundEmail,
        operationalReady: async () => true,
      } as unknown as EmailSyncDeps;

      const result = await processMessage(deps, 'owner', 'bot@example.test', new Map(), 'replay');

      expect(result).toBe('skipped');
      expect(createTask).toHaveBeenCalledTimes(expectedTaskCalls);
      expect(expireDue).not.toHaveBeenCalled();
      expect(observeInboundEmail).not.toHaveBeenCalled();
      expect(model).not.toHaveBeenCalled();
    },
  );
});
