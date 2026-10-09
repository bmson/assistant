import type { RecoverableDirectIngest } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { googleDurableEmailObservers } from './durable-email-observers.js';
import type { EmailSyncDeps } from './email-sync.js';
import { emailContentProvenance, recoverDirectIngests } from './email-sync.js';

const owner = 'owner@example.test';
const messageId = 'recovery-message';
const channelMessageId = `gmail:${messageId}`;
const subject = 'A saved direct message';
const body = 'This is a bounded synthetic authenticated owner message used for recovery testing.';
const rfcMessageId = '<recovery-message@example.test>';

function sourceMessage() {
  return {
    id: messageId,
    threadId: 'thread-1',
    internalDate: '1791531760562',
    labelIds: ['INBOX'],
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: `Owner <${owner}>` },
        { name: 'Subject', value: subject },
        { name: 'Message-ID', value: rfcMessageId },
        {
          name: 'Authentication-Results',
          value: 'mx.google.com; dmarc=pass header.from=example.test',
        },
      ],
      body: { data: Buffer.from(body).toString('base64url') },
    },
  };
}

function makeRow(overrides: Partial<RecoverableDirectIngest> = {}): RecoverableDirectIngest {
  const message = sourceMessage();
  const provenance = emailContentProvenance(message.payload, {
    subject,
    fullBody: body,
    storedBody: body,
    messagePrefix: `From: ${owner}\nSubject: ${subject}\n\n`,
    authenticated: true,
    mode: 'direct',
  });
  return {
    id: '2f721dd0-e593-4222-a299-3d5f1d77e601',
    agentId: 'agent-1',
    mailbox: owner,
    channelMessageId,
    providerMessageId: messageId,
    providerThreadId: 'thread-1',
    sourceMessageId: rfcMessageId,
    conversationId: null,
    authenticated: true,
    fromEmail: owner,
    fromName: 'Owner',
    subject,
    contentTrust: 'owner',
    hasExternalOrUnknown: false,
    emailContentProvenance: provenance,
    directRouting: 'application_confirmation',
    directRecoveryReason: null,
    classificationStatus: 'prepared',
    classificationClaimToken: 'classification-claim-1',
    preparedClassification: { automated: false },
    scoreStatus: 'prepared',
    scoreClaimToken: 'score-claim-1',
    scoreOutcome: 'model_prepared',
    score: {
      category: 'other',
      importance: 3,
      actionable: true,
      reason: 'Saved checkpoint',
      dates: [],
      cardCandidate: false,
      nextStep: null,
      securityEvidence: null,
    },
    pipelineStage: 'score_prepared',
    admittedSourceKind: null,
    admittedSourceId: null,
    messagePersisted: false,
    updatedAt: new Date('2026-10-08T12:00:00.000Z'),
    ...overrides,
  } as RecoverableDirectIngest;
}

function fixture(row: RecoverableDirectIngest = makeRow()) {
  const lease = {
    holder: 'sync-holder',
    generation: 7,
    renew: vi.fn(async () => undefined),
    assertCurrent: vi.fn(async () => undefined),
  };
  const repository = {
    mailbox: vi.fn(async () => ({ email: owner })),
    listRecoverableDirectIngests: vi.fn(async () => [row]),
    markDirectIngestRecoveryUnavailable: vi.fn(async () => true),
    privacyObservationFence: vi.fn(async () => null),
    ingestRecord: vi.fn(async () => row),
    conversationForThread: vi.fn(async () => 'conversation-1'),
    commitEmailAdmission: vi.fn(async () => {
      (
        row as unknown as { admittedSourceKind: 'message'; admittedSourceId: string }
      ).admittedSourceKind = 'message';
      (
        row as unknown as { admittedSourceKind: 'message'; admittedSourceId: string }
      ).admittedSourceId = 'persisted-source-1';
      return {
        messageId: 'persisted-source-1',
        sourceId: 'persisted-source-1',
        ingestId: '2f721dd0-e593-4222-a299-3d5f1d77e601',
        observerIds: [],
        duplicate: false,
      };
    }),
    markIngestClassificationUnknown: vi.fn(async () => undefined),
    markIngestScoreUnknown: vi.fn(async () => undefined),
  };
  const object = vi.fn();
  const api = vi.fn(async () => sourceMessage());
  const deps = {
    config: {
      GMAIL_SYNC_ENABLED: 'true',
      EMAIL_INGEST_MODE: 'direct',
      ASSISTANT_MODULES: ['google'],
    },
    persistence: { emailSync: repository },
    router: { object },
    workspace: {},
    googleClient: { configured: () => true, api },
    notifyOwner: vi.fn(),
    observeInboundEmail: vi.fn(),
    durableEmailObservers: googleDurableEmailObservers({} as never),
    operationalReady: async () => true,
  } as unknown as EmailSyncDeps;
  return { deps, repository, lease, api, object, row };
}

describe('direct email recovery scan', () => {
  it.each([
    [
      'classification',
      {
        classificationStatus: 'in_progress',
        classificationClaimToken: 'classifier-token',
        preparedClassification: null,
      },
    ],
    ['score', { scoreStatus: 'in_progress', scoreClaimToken: 'score-token' }],
  ] as const)(
    'marks an interrupted %s claim unknown without refetching or retrying it',
    async (stage, overrides) => {
      const state = fixture(makeRow(overrides));
      await recoverDirectIngests(state.deps, {
        agentId: 'agent-1',
        mailbox: owner,
        botEmail: 'bot@example.test',
        contactTrustByEmail: new Map([[owner, 'owner']]),
        observationFence: null,
        lease: state.lease,
      });

      expect(state.api).not.toHaveBeenCalled();
      expect(state.object).not.toHaveBeenCalled();
      if (stage === 'classification') {
        expect(state.repository.markIngestClassificationUnknown).toHaveBeenCalledWith(
          'agent-1',
          '2f721dd0-e593-4222-a299-3d5f1d77e601',
          'classifier-token',
          null,
          null,
          state.lease,
        );
      } else {
        expect(state.repository.markIngestScoreUnknown).toHaveBeenCalledWith(
          'agent-1',
          '2f721dd0-e593-4222-a299-3d5f1d77e601',
          'score-token',
          null,
          state.lease,
        );
      }
      expect(state.repository.commitEmailAdmission).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['classification', { classificationStatus: 'in_progress', classificationClaimToken: null }],
    ['score', { scoreStatus: 'in_progress', scoreClaimToken: null }],
  ] as const)(
    'terminalizes an interrupted %s row with no claim token as inconsistent',
    async (_stage, overrides) => {
      const state = fixture(makeRow(overrides));
      await recoverDirectIngests(state.deps, {
        agentId: 'agent-1',
        mailbox: owner,
        botEmail: 'bot@example.test',
        contactTrustByEmail: new Map([[owner, 'owner']]),
        observationFence: null,
        lease: state.lease,
      });

      expect(state.api).not.toHaveBeenCalled();
      expect(state.object).not.toHaveBeenCalled();
      expect(state.repository.markDirectIngestRecoveryUnavailable).toHaveBeenCalledWith(
        expect.objectContaining({
          ingestId: '2f721dd0-e593-4222-a299-3d5f1d77e601',
          reason: 'checkpoint_inconsistent',
        }),
      );
    },
  );

  it('reuses prepared checkpoints and frozen route after validating the provider source', async () => {
    const state = fixture();
    const result = await recoverDirectIngests(state.deps, {
      agentId: 'agent-1',
      mailbox: owner,
      botEmail: 'bot@example.test',
      contactTrustByEmail: new Map([[owner, 'owner']]),
      observationFence: null,
      lease: state.lease,
    });

    expect(state.api).toHaveBeenCalledOnce();
    expect(state.object).not.toHaveBeenCalled();
    expect(state.repository.conversationForThread).toHaveBeenCalledWith(
      'agent-1',
      'thread-1',
      'owner',
      subject,
      { expectedPrivacyGeneration: null },
    );
    expect(state.repository.commitEmailAdmission).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPrivacyGeneration: null,
        finalizedIngest: expect.objectContaining({
          directRouting: 'application_confirmation',
          scoreClaimToken: 'score-claim-1',
          classificationClaimToken: 'classification-claim-1',
        }),
      }),
    );
    expect(result).toEqual({ processed: 1, morePending: false });
  });

  it('terminalizes a mismatched checkpoint before contacting Gmail', async () => {
    const state = fixture(makeRow({ channelMessageId: 'gmail:another-message' }));
    await recoverDirectIngests(state.deps, {
      agentId: 'agent-1',
      mailbox: owner,
      botEmail: 'bot@example.test',
      contactTrustByEmail: new Map([[owner, 'owner']]),
      observationFence: null,
      lease: state.lease,
    });

    expect(state.api).not.toHaveBeenCalled();
    expect(state.repository.markDirectIngestRecoveryUnavailable).toHaveBeenCalledWith(
      expect.objectContaining({
        ingestId: '2f721dd0-e593-4222-a299-3d5f1d77e601',
        reason: 'checkpoint_inconsistent',
        expectedPrivacyGeneration: null,
        lease: state.lease,
      }),
    );
  });

  it('rejects a source whose frozen external-content flag disagrees with its provenance snapshot', async () => {
    const state = fixture(makeRow({ hasExternalOrUnknown: true }));
    await recoverDirectIngests(state.deps, {
      agentId: 'agent-1',
      mailbox: owner,
      botEmail: 'bot@example.test',
      contactTrustByEmail: new Map([[owner, 'owner']]),
      observationFence: null,
      lease: state.lease,
    });

    expect(state.api).not.toHaveBeenCalled();
    expect(state.repository.markDirectIngestRecoveryUnavailable).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'checkpoint_inconsistent' }),
    );
  });

  it('records an unavailable provider read without failing the whole bounded sync pass', async () => {
    const state = fixture();
    state.api.mockRejectedValue(new Error('synthetic network interruption'));
    await expect(
      recoverDirectIngests(state.deps, {
        agentId: 'agent-1',
        mailbox: owner,
        botEmail: 'bot@example.test',
        contactTrustByEmail: new Map([[owner, 'owner']]),
        observationFence: null,
        lease: state.lease,
      }),
    ).resolves.toEqual({ processed: 0, morePending: false });

    expect(state.repository.markDirectIngestRecoveryUnavailable).toHaveBeenCalledWith(
      expect.objectContaining({
        ingestId: '2f721dd0-e593-4222-a299-3d5f1d77e601',
        reason: 'provider_temporarily_unavailable',
      }),
    );
    expect(state.repository.commitEmailAdmission).not.toHaveBeenCalled();
    expect(state.object).not.toHaveBeenCalled();
  });

  it.each([
    ['classification', { classificationStatus: 'unknown', preparedClassification: null }],
    ['score', { scoreStatus: 'unknown', scoreOutcome: 'provider_outcome_unknown', score: null }],
  ] as const)(
    'does not recover an unknown %s outcome without a stored fallback',
    async (_stage, overrides) => {
      const state = fixture(makeRow(overrides));
      await recoverDirectIngests(state.deps, {
        agentId: 'agent-1',
        mailbox: owner,
        botEmail: 'bot@example.test',
        contactTrustByEmail: new Map([[owner, 'owner']]),
        observationFence: null,
        lease: state.lease,
      });

      expect(state.api).not.toHaveBeenCalled();
      expect(state.object).not.toHaveBeenCalled();
      expect(state.repository.commitEmailAdmission).not.toHaveBeenCalled();
      expect(state.repository.markDirectIngestRecoveryUnavailable).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'checkpoint_inconsistent' }),
      );
    },
  );

  it('reuses the exact stored fail-open score without asking the model again', async () => {
    const state = fixture(
      makeRow({
        classificationStatus: 'unknown',
        classificationClaimToken: 'classifier-unknown-token',
        scoreStatus: 'unknown',
        scoreOutcome: 'fallback_committed_unknown',
        scoreClaimToken: 'score-unknown-token',
      }),
    );
    await recoverDirectIngests(state.deps, {
      agentId: 'agent-1',
      mailbox: owner,
      botEmail: 'bot@example.test',
      contactTrustByEmail: new Map([[owner, 'owner']]),
      observationFence: null,
      lease: state.lease,
    });

    expect(state.api).toHaveBeenCalledOnce();
    expect(state.object).not.toHaveBeenCalled();
    expect(state.repository.commitEmailAdmission).toHaveBeenCalledOnce();
    expect(state.repository.markDirectIngestRecoveryUnavailable).not.toHaveBeenCalled();
  });

  it('caps each recovery pass to ten rows and reports remaining work', async () => {
    const state = fixture();
    const rows = Array.from({ length: 12 }, (_, index) =>
      makeRow({
        id: `ingest-${index}`,
        classificationStatus: 'in_progress',
        classificationClaimToken: `classifier-${index}`,
      }),
    );
    state.repository.listRecoverableDirectIngests.mockResolvedValue(rows);
    const result = await recoverDirectIngests(state.deps, {
      agentId: 'agent-1',
      mailbox: owner,
      botEmail: 'bot@example.test',
      contactTrustByEmail: new Map([[owner, 'owner']]),
      observationFence: null,
      lease: state.lease,
    });

    expect(state.repository.listRecoverableDirectIngests).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10 }),
    );
    expect(state.repository.markIngestClassificationUnknown).toHaveBeenCalledTimes(10);
    expect(state.api).not.toHaveBeenCalled();
    expect(result.morePending).toBe(true);
  });
});
