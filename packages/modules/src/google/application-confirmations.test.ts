import { createHash } from 'node:crypto';
import type {
  ApplicationConfirmationRecord,
  ApplicationConfirmationRepository,
} from '@assistant/persistence';
import { applicationConfirmationSourceDigest } from '@assistant/persistence';
import { hashConfirmationToken } from '@assistant/tools';
import { describe, expect, it, vi } from 'vitest';
import {
  confirmationTokenHashes,
  executeApplicationConfirmationTask,
  processApplicationConfirmation,
} from './application-confirmations.js';

function provenance(body: string, splitAt = body.length) {
  const hash = createHash('sha256')
    .update('assistant-email-content-v1\0')
    .update(body)
    .digest('hex');
  return {
    version: 1 as const,
    mode: 'direct' as const,
    authenticated: true,
    sourceLength: body.length,
    storedLength: body.length,
    sourceHash: hash,
    bodyHash: hash,
    messageHash: hash,
    prefixLength: 0,
    hasExternalOrUnknown: splitAt < body.length,
    spans: [
      { start: 0, end: splitAt, author: 'sender' as const },
      ...(splitAt < body.length
        ? [{ start: splitAt, end: body.length, author: 'external' as const }]
        : []),
    ],
    parts: [
      {
        path: '0',
        mimeType: 'text/plain',
        quoteMarkup: splitAt < body.length,
        replyHeaders: false,
      },
    ],
  };
}

describe('confirmationTokenHashes', () => {
  it('matches a plain reference token', () => {
    const hashes = confirmationTokenHashes('Your reference is REQ-12345, thanks.');
    expect(hashes.has(hashConfirmationToken('REQ-12345'))).toBe(true);
  });

  it('recovers a token split by an invisible character or entity', () => {
    const target = hashConfirmationToken('REQ-12345');
    const softHyphen = '\u00AD';
    const zeroWidth = '\u200B';
    for (const body of [
      `reference REQ-${softHyphen}12345 confirmed`,
      `reference REQ-${zeroWidth}12345 confirmed`,
      'reference REQ-&shy;12345 confirmed',
      'reference REQ-&#8203;12345 confirmed',
    ]) {
      expect(confirmationTokenHashes(body).has(target)).toBe(true);
    }
  });

  it('does not fabricate a token from ordinary spaced words', () => {
    // Removing invisible breaks must not join visibly separate words.
    const hashes = confirmationTokenHashes('thank you for applying today');
    expect(hashes.has(hashConfirmationToken('applyingtoday'))).toBe(false);
  });
});

it('does not complete an ambiguous observer when the durable repository rejects current matches', async () => {
  const now = new Date();
  const agentId = 'owner-ambiguous-recheck';
  const messageId = 'provider-ambiguous-recheck';
  const from = 'sender@example.test';
  const subject = 'Application receipt';
  const body = 'Reference REQ-123456 and REQ-654321 confirmed';
  const watches = ['REQ-123456', 'REQ-654321'].map(
    (token, index) =>
      ({
        id: `watch-ambiguous-${index}`,
        agentId,
        status: 'awaiting_confirmation',
        expiresAt: new Date(now.getTime() + 60_000),
        expectedSenderEmails: [from],
        confirmationTokenHash: hashConfirmationToken(token),
        confirmationTokenHint: token.slice(-4),
        conversationId: null,
      }) as ApplicationConfirmationRecord,
  );
  const applications = {
    expireDue: vi.fn(),
    byConfirmationMessage: vi.fn().mockResolvedValue(null),
    awaitingFrom: vi.fn().mockResolvedValue(watches),
    recordAmbiguousObserver: vi.fn().mockResolvedValue({ kind: 'not_ambiguous' }),
  } as unknown as ApplicationConfirmationRepository;
  const notifyOwner = vi.fn();
  const append = vi.fn();
  const enqueue = vi.fn();
  const fence = {
    id: 'observer-ambiguous-recheck',
    agentId,
    claimToken: 'claim-ambiguous-recheck',
    claimGeneration: 3,
    expectedPrivacyGeneration: null,
  };

  const outcome = await processApplicationConfirmation(
    {
      persistence: {
        applications,
        tasks: { enqueue } as never,
        messages: { append } as never,
      },
      notifyOwner,
    },
    {
      agentId,
      messageId,
      from,
      subject,
      body,
      authenticated: true,
      now,
      emailObserverEffectFence: fence,
      emailContentProvenance: provenance(body),
    },
  );

  expect(outcome).toEqual({ kind: 'ignored' });
  expect(applications.recordAmbiguousObserver).toHaveBeenCalledWith({
    emailObserverEffectFence: fence,
  });
  expect(notifyOwner).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
});

describe('durable application confirmation claim fence', () => {
  it('does not run lazy expiry or claim a watch unless the durable source digest and owner fence are supplied', async () => {
    const now = new Date();
    const agentId = 'owner-1';
    const messageId = 'provider-message-1';
    const from = 'sender@example.test';
    const subject = 'Your application receipt';
    const body = 'Reference REQ-123456 confirmed';
    const confirmationTokenHash = hashConfirmationToken('REQ-123456');
    const watch = {
      id: 'watch-1',
      agentId,
      status: 'awaiting_confirmation',
      expiresAt: new Date(now.getTime() + 60_000),
      expectedSenderEmails: [from],
      confirmationTokenHash,
      confirmationTokenHint: '3456',
      conversationId: null,
    } as ApplicationConfirmationRecord;
    const applications = {
      expireDue: vi.fn(),
      byConfirmationMessage: vi.fn().mockResolvedValue(null),
      awaitingFrom: vi.fn().mockResolvedValue([watch]),
      claim: vi.fn().mockResolvedValue(null),
      claimAndEnqueue: vi.fn().mockResolvedValue(null),
      get: vi.fn().mockResolvedValue(watch),
    } as unknown as ApplicationConfirmationRepository;
    const fence = {
      id: 'observer-work-1',
      agentId,
      claimToken: 'claim-1',
      claimGeneration: 2,
      expectedPrivacyGeneration: null,
    };
    const deps = {
      persistence: { applications, tasks: {} as never, messages: {} as never },
      notifyOwner: vi.fn(),
    };

    await expect(
      processApplicationConfirmation(deps, {
        agentId,
        messageId,
        from,
        subject,
        body,
        authenticated: true,
        now,
        emailObserverEffectFence: fence,
        emailContentProvenance: provenance(body),
      }),
    ).rejects.toThrow('application_confirmation_claim_rejected');
    expect(applications.expireDue).not.toHaveBeenCalled();
    expect(applications.claimAndEnqueue).toHaveBeenCalledWith(watch.id, {
      confirmationMessageId: `gmail:${messageId}`,
      confirmationFrom: from,
      now,
      emailObserverEffectFence: fence,
      confirmationTokenHash,
      sourceDigest: applicationConfirmationSourceDigest({
        confirmationMessageId: `gmail:${messageId}`,
        confirmationFrom: from,
        subject,
        body,
      }),
    });
    expect(applications.claim).not.toHaveBeenCalled();
    expect(deps.notifyOwner).not.toHaveBeenCalled();
  });

  it('uses the atomic durable watch-and-task handoff for a matched fenced email', async () => {
    const now = new Date();
    const agentId = 'owner-2';
    const messageId = 'provider-message-2';
    const from = 'sender@example.test';
    const subject = 'Your application receipt';
    const body = 'Reference REQ-123456 confirmed';
    const confirmationTokenHash = hashConfirmationToken('REQ-123456');
    const watch = {
      id: 'watch-2',
      agentId,
      status: 'awaiting_confirmation',
      expiresAt: new Date(now.getTime() + 60_000),
      expectedSenderEmails: [from],
      confirmationTokenHash,
      confirmationTokenHint: '3456',
      conversationId: null,
    } as ApplicationConfirmationRecord;
    const task = {
      id: 'task-2',
      status: 'pending',
      queueGeneration: 1,
    } as never;
    const applications = {
      expireDue: vi.fn(),
      byConfirmationMessage: vi.fn().mockResolvedValue(null),
      awaitingFrom: vi.fn().mockResolvedValue([watch]),
      claim: vi.fn(),
      claimAndEnqueue: vi.fn().mockResolvedValue({
        record: { ...watch, status: 'confirmation_received' },
        task,
        created: false,
      }),
      get: vi.fn().mockResolvedValue(watch),
    } as unknown as ApplicationConfirmationRepository;
    const fence = {
      id: 'observer-work-2',
      agentId,
      claimToken: 'claim-2',
      claimGeneration: 1,
      expectedPrivacyGeneration: null,
    };
    const deps = {
      persistence: { applications, tasks: {} as never, messages: {} as never },
      notifyOwner: vi.fn(),
    };

    const outcome = await processApplicationConfirmation(deps, {
      agentId,
      messageId,
      from,
      subject,
      body,
      authenticated: true,
      now,
      emailObserverEffectFence: fence,
      emailContentProvenance: provenance(body),
    });

    expect(outcome).toEqual({ kind: 'in_progress', applicationId: watch.id });
    expect(applications.claim).not.toHaveBeenCalled();
    expect(applications.claimAndEnqueue).toHaveBeenCalledWith(watch.id, {
      confirmationMessageId: `gmail:${messageId}`,
      confirmationFrom: from,
      now,
      emailObserverEffectFence: fence,
      confirmationTokenHash,
      sourceDigest: applicationConfirmationSourceDigest({
        confirmationMessageId: `gmail:${messageId}`,
        confirmationFrom: from,
        subject,
        body,
      }),
    });
  });

  it('matches only sender-authored confirmation tokens when another watch token is quoted', async () => {
    const now = new Date();
    const agentId = 'owner-3';
    const messageId = 'provider-message-3';
    const from = 'sender@example.test';
    const subject = 'Application receipt';
    const authoredToken = 'REQ-123456';
    const quotedToken = 'REQ-654321';
    const splitAt = `Reference ${authoredToken}\n> old reference ${quotedToken}`.indexOf('>');
    const body = `Reference ${authoredToken}\n> old reference ${quotedToken}`;
    const watch = (id: string, token: string) =>
      ({
        id,
        agentId,
        status: 'awaiting_confirmation',
        expiresAt: new Date(now.getTime() + 60_000),
        expectedSenderEmails: [from],
        confirmationTokenHash: hashConfirmationToken(token),
        confirmationTokenHint: token.slice(-4),
        conversationId: null,
      }) as ApplicationConfirmationRecord;
    const authoredWatch = watch('authored-watch', authoredToken);
    const quotedWatch = watch('quoted-watch', quotedToken);
    const handoff = {
      record: { ...authoredWatch, status: 'confirmation_received' },
      task: { id: 'task-3', status: 'pending', queueGeneration: 1 },
      created: false,
    } as never;
    const applications = {
      expireDue: vi.fn(),
      byConfirmationMessage: vi.fn().mockResolvedValue(null),
      awaitingFrom: vi.fn().mockResolvedValue([authoredWatch, quotedWatch]),
      claim: vi.fn(),
      claimAndEnqueue: vi.fn().mockResolvedValue(handoff),
      get: vi.fn(),
    } as unknown as ApplicationConfirmationRepository;
    const fence = {
      id: 'observer-work-3',
      agentId,
      claimToken: 'claim-3',
      claimGeneration: 1,
      expectedPrivacyGeneration: null,
    };
    const deps = {
      persistence: { applications, tasks: {} as never, messages: {} as never },
      notifyOwner: vi.fn(),
    };

    const outcome = await processApplicationConfirmation(deps, {
      agentId,
      messageId,
      from,
      subject,
      body,
      authenticated: true,
      now,
      emailObserverEffectFence: fence,
      emailContentProvenance: provenance(body, splitAt),
    });

    expect(outcome).toEqual({ kind: 'in_progress', applicationId: authoredWatch.id });
    expect(applications.claimAndEnqueue).toHaveBeenCalledTimes(1);
    expect(applications.claimAndEnqueue).toHaveBeenCalledWith(
      authoredWatch.id,
      expect.objectContaining({ confirmationTokenHash: authoredWatch.confirmationTokenHash }),
    );
  });

  it('surfaces rejected durable claims for retry without completing an unchanged watch', async () => {
    const now = new Date();
    const agentId = 'owner-4';
    const messageId = 'provider-message-4';
    const from = 'sender@example.test';
    const subject = 'Your application receipt';
    const body = 'Reference REQ-123456 confirmed';
    const confirmationTokenHash = hashConfirmationToken('REQ-123456');
    const watch = {
      id: 'watch-4',
      agentId,
      status: 'awaiting_confirmation',
      expiresAt: new Date(now.getTime() + 60_000),
      expectedSenderEmails: [from],
      confirmationTokenHash,
      confirmationTokenHint: '3456',
      conversationId: null,
    } as ApplicationConfirmationRecord;
    const applications = {
      expireDue: vi.fn(),
      byConfirmationMessage: vi.fn().mockResolvedValue(null),
      awaitingFrom: vi.fn().mockResolvedValue([watch]),
      claim: vi.fn(),
      claimAndEnqueue: vi.fn().mockResolvedValue(null),
      get: vi.fn().mockResolvedValue(watch),
    } as unknown as ApplicationConfirmationRepository;
    const fence = {
      id: 'observer-work-4',
      agentId,
      claimToken: 'claim-4',
      claimGeneration: 1,
      expectedPrivacyGeneration: null,
    };

    await expect(
      processApplicationConfirmation(
        {
          persistence: { applications, tasks: {} as never, messages: {} as never },
          notifyOwner: vi.fn(),
        },
        {
          agentId,
          messageId,
          from,
          subject,
          body,
          authenticated: true,
          now,
          emailObserverEffectFence: fence,
          emailContentProvenance: provenance(body),
        },
      ),
    ).rejects.toThrow('application_confirmation_claim_rejected');
  });

  it('blocks delayed Google dispatch when the owner generation changed after atomic handoff', async () => {
    const agentId = 'owner-5';
    const applicationId = 'watch-5';
    const taskId = 'task-5';
    const trigger = {
      source: 'internal',
      payload: {
        kind: 'application_confirmation',
        applicationId,
        confirmationMessageId: 'gmail:provider-message-5',
        producerPrivacyGeneration: 'captured-generation',
      },
    };
    const queued = {
      id: taskId,
      agentId,
      status: 'pending',
      trigger,
      conversationId: null,
    };
    const lease = {
      ...queued,
      status: 'running',
      leaseToken: 'lease-5',
      lockedUntil: new Date(Date.now() + 60_000),
    } as never;
    const tasks = {
      kind: 'task-lease-repository',
      getTask: vi.fn().mockResolvedValue(queued),
      claim: vi.fn().mockResolvedValue(lease),
      markTaskNeedsAttention: vi.fn().mockResolvedValue(true),
    };
    const record = {
      id: applicationId,
      agentId,
      status: 'confirmation_received',
      producerPrivacyGeneration: 'captured-generation',
      trackerUpdate: {
        spreadsheetId: 'sheet-1',
        sheetName: 'Applications',
        startCell: 'A1',
        rows: [['x']],
      },
      documentUpdate: null,
      actionState: {},
      company: 'Example Corp',
      role: 'Engineer',
      confirmationTokenHint: '3456',
      conversationId: null,
    } as ApplicationConfirmationRecord;
    const applications = {
      get: vi.fn().mockResolvedValue(record),
      isPrivacyGenerationCurrent: vi.fn().mockResolvedValue(false),
    } as unknown as ApplicationConfirmationRepository;
    const dispatch = vi.fn();

    const outcome = await executeApplicationConfirmationTask(
      {
        persistence: { applications, tasks: tasks as never, messages: {} as never },
        notifyOwner: vi.fn(),
        dispatcher: { dispatch } as never,
        db: {} as never,
      },
      taskId,
    );

    expect(outcome).toEqual({ outcome: 'needs_attention', applicationId });
    expect(applications.isPrivacyGenerationCurrent).toHaveBeenCalledWith(
      agentId,
      'captured-generation',
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(tasks.markTaskNeedsAttention).toHaveBeenCalledOnce();
  });

  it('parks legacy delayed tasks without a frozen generation before any effect or notice', async () => {
    const agentId = 'owner-legacy-generation';
    const applicationId = 'watch-legacy-generation';
    const taskId = 'task-legacy-generation';
    const queued = {
      id: taskId,
      agentId,
      status: 'pending',
      trigger: {
        source: 'internal',
        payload: { kind: 'application_confirmation', applicationId },
      },
      conversationId: 'conversation-legacy-generation',
    };
    const lease = {
      ...queued,
      status: 'running',
      leaseToken: 'lease-legacy-generation',
      lockedUntil: new Date(Date.now() + 60_000),
    } as never;
    const tasks = {
      kind: 'task-lease-repository',
      getTask: vi.fn().mockResolvedValue(queued),
      claim: vi.fn().mockResolvedValue(lease),
      markTaskNeedsAttention: vi.fn().mockResolvedValue(true),
    };
    const record = {
      id: applicationId,
      agentId,
      status: 'confirmation_received',
      producerPrivacyGeneration: null,
      trackerUpdate: {
        spreadsheetId: 'sheet-legacy-generation',
        sheetName: 'Applications',
        startCell: 'A1',
        rows: [['Example Corp', 'Engineer']],
      },
      documentUpdate: null,
      actionState: {},
      company: 'Example Corp',
      role: 'Engineer',
      confirmationTokenHint: '3456',
      confirmationMessageId: 'gmail:legacy-generation',
      conversationId: queued.conversationId,
    } as ApplicationConfirmationRecord;
    const applications = {
      get: vi.fn().mockResolvedValue(record),
      isPrivacyGenerationCurrent: vi.fn().mockResolvedValue(true),
    } as unknown as ApplicationConfirmationRepository;
    const append = vi.fn();
    const notifyOwner = vi.fn();
    const dispatch = vi.fn();
    const outcome = await executeApplicationConfirmationTask(
      {
        persistence: {
          applications,
          tasks: tasks as never,
          messages: { append } as never,
        },
        notifyOwner,
        dispatcher: { dispatch } as never,
        db: {} as never,
      },
      taskId,
    );

    expect(outcome).toEqual({ outcome: 'needs_attention', applicationId });
    expect(dispatch).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(notifyOwner).not.toHaveBeenCalled();
    expect(applications.isPrivacyGenerationCurrent).not.toHaveBeenCalled();
    expect(tasks.markTaskNeedsAttention).toHaveBeenCalledOnce();
  });
});
