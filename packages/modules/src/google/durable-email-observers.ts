import { enqueueTask, TaskRateLimitError } from '@assistant/core';
import type { EmailAttachmentPreparedResult } from '@assistant/persistence';
import {
  embeddingSpaceIdentityKey,
  isValidEmailObserverPreparedResult,
  validateEmbedding,
} from '@assistant/persistence';
import type { GmailPayload } from '@assistant/tools';
import type { GoogleClient } from '@assistant/tools/modules/google';
import type { InboundEmailObserver } from '../platform.js';
import {
  applicationPersistence,
  processApplicationConfirmation,
} from './application-confirmations.js';
import { applyPreparedEmailCard, prepareEmailCard } from './email-cards.js';
import { fileEmailAttachmentsForObserver, preparedEmailAttachmentManifest } from './email-sync.js';

const AUTO_SAMPLE_PREFIX = 'auto:';
const MIN_SAMPLE_CHARS = 80;
const MAX_SAMPLE_CHARS = 4000;
const MAX_AUTO_SAMPLES = 300;
const MAX_EMBEDDING_DIMENSIONS = 2048;

function providerMessageId(channelMessageId: string): string | null {
  if (!channelMessageId.startsWith('gmail:')) return null;
  const id = channelMessageId.slice('gmail:'.length);
  return id.length > 0 ? id : null;
}

const cardObserver: InboundEmailObserver = {
  identity: { key: 'google.email-card', version: 1, workClass: 'paid_ambiguous' },
  shouldRun: (services) => services.config.GENERATIVE_CARDS_ENABLED === true,
  prepare: async (services, source) => prepareEmailCard({ router: services.router }, source),
  apply: async (services, source, claim, prepared) => {
    const outcome = await applyPreparedEmailCard(
      {
        router: services.router,
        generatedCards: services.persistence.generatedCards,
        notifications: services.persistence.notifications,
        notifyOwner: services.ownerNotifier.notifyOwner,
      },
      source,
      claim,
      prepared,
    );
    return outcome === 'unknown'
      ? { kind: 'unknown', errorCode: 'email_card_effect_unknown' }
      : { kind: outcome };
  },
};

const applicationConfirmationObserver: InboundEmailObserver = {
  identity: {
    key: 'google.application-confirmation',
    version: 1,
    workClass: 'idempotent_db',
  },
  prepare: async (_services, source) =>
    source.authenticated && !(source.ingestMode === 'direct' && source.directRouting)
      ? { kind: 'prepared', result: {} }
      : { kind: 'no_op' },
  apply: async (services, source, claim) => {
    const messageId = providerMessageId(claim.channelMessageId);
    if (!messageId) return { kind: 'unknown', errorCode: 'email_provider_id_invalid' };
    const emailObserverEffectFence = {
      id: claim.id,
      agentId: claim.agentId,
      claimToken: claim.claimToken,
      claimGeneration: claim.claimGeneration,
      expectedPrivacyGeneration: claim.privacyGeneration,
    };
    const outcome = await processApplicationConfirmation(
      {
        persistence: applicationPersistence(services.persistence),
        notifyOwner: (input) =>
          services.ownerNotifier.notifyOwner({
            ...input,
            emailObserverEffectFence,
          }),
      },
      {
        agentId: source.agentId,
        messageId,
        from: source.from,
        subject: source.subject,
        body: source.body,
        authenticated: source.authenticated,
        emailContentProvenance: source.emailContentProvenance,
        emailObserverEffectFence,
      },
    );
    return outcome.kind === 'ignored' ? { kind: 'no_op' } : { kind: 'complete' };
  },
};

const directEmailRoutingObserver: InboundEmailObserver = {
  identity: {
    key: 'google.direct-email-routing',
    version: 1,
    workClass: 'idempotent_db',
  },
  prepare: async (_services, source) => {
    if (source.ingestMode !== 'direct' || !source.authenticated) return { kind: 'no_op' };
    if (!['application_confirmation', 'email_triage'].includes(source.directRouting ?? ''))
      return { kind: 'unknown', errorCode: 'direct_email_route_missing' };
    return { kind: 'prepared', result: { route: source.directRouting } };
  },
  apply: async (services, source, claim, prepared) => {
    const route = (prepared as { route?: unknown } | null)?.route;
    if (
      source.ingestMode !== 'direct' ||
      !source.authenticated ||
      (route !== 'application_confirmation' && route !== 'email_triage') ||
      route !== source.directRouting
    )
      return { kind: 'unknown', errorCode: 'direct_email_route_invalid' };

    const messageId = providerMessageId(claim.channelMessageId);
    if (!messageId) return { kind: 'unknown', errorCode: 'email_provider_id_invalid' };
    const sync = services.persistence.emailSync;
    if (!sync) return { kind: 'unknown', errorCode: 'email_sync_persistence_unavailable' };
    const ingest = await sync.ingestRecord(claim.channelMessageId);
    if (
      !ingest ||
      ingest.agentId !== source.agentId ||
      ingest.ingestMode !== 'direct' ||
      ingest.admittedSourceKind === null ||
      ingest.directRouting !== route ||
      ingest.providerMessageId !== messageId
    )
      return { kind: 'unknown', errorCode: 'direct_email_ingest_unavailable' };

    if (route === 'application_confirmation') {
      const emailObserverEffectFence = {
        id: claim.id,
        agentId: claim.agentId,
        claimToken: claim.claimToken,
        claimGeneration: claim.claimGeneration,
        expectedPrivacyGeneration: claim.privacyGeneration,
      };
      const outcome = await processApplicationConfirmation(
        {
          persistence: applicationPersistence(services.persistence),
          notifyOwner: (input) =>
            services.ownerNotifier.notifyOwner({ ...input, emailObserverEffectFence }),
        },
        {
          agentId: source.agentId,
          messageId,
          from: source.from,
          subject: source.subject,
          body: source.body,
          authenticated: true,
          emailContentProvenance: source.emailContentProvenance,
          emailObserverEffectFence,
        },
      );
      if (outcome.kind === 'ignored')
        return { kind: 'unknown', errorCode: 'application_route_no_longer_matches' };
      return { kind: 'complete' };
    }

    if (!ingest.conversationId)
      return { kind: 'unknown', errorCode: 'direct_email_ingest_unavailable' };

    // Automated mail remains admitted for its other durable observers, but it
    // does not create a generic conversation task.
    if (ingest.preparedClassification?.automated === true) return { kind: 'no_op' };
    if (!ingest.providerThreadId || !ingest.providerMessageId || !ingest.emailContentProvenance)
      return { kind: 'unknown', errorCode: 'direct_email_task_metadata_missing' };

    try {
      await enqueueTask(services.persistence.tasks, {
        type: 'email_triage',
        maxSteps: 16,
        budgetUsdLimit: '1.20',
        emailObserverTaskFence: {
          id: claim.id,
          agentId: claim.agentId,
          claimToken: claim.claimToken,
          claimGeneration: claim.claimGeneration,
          expectedPrivacyGeneration: claim.privacyGeneration,
          channelMessageId: claim.channelMessageId,
        },
        event: {
          source: 'email',
          externalEventId: claim.channelMessageId,
          agentId: source.agentId,
          conversationId: ingest.conversationId,
          trust: source.contentTrust,
          payload: {
            threadId: ingest.providerThreadId,
            messageId: ingest.providerMessageId,
            rfcMessageId: ingest.sourceMessageId,
            from: source.from,
            subject: source.subject,
            quotesExternalContent: source.hasExternalOrUnknown,
            emailProvenance: ingest.emailContentProvenance,
            ingest: {
              forwarded: false,
              contentTrust: source.contentTrust,
              authenticated: true,
              importance: ingest.importance,
              category: ingest.category,
              ownerAlerted: false,
            },
          },
        },
      });
      return { kind: 'complete' };
    } catch (error) {
      if (error instanceof TaskRateLimitError)
        return { kind: 'retryable_failed', errorCode: 'email_triage_rate_limited' };
      return { kind: 'retryable_failed', errorCode: 'email_triage_enqueue_failed' };
    }
  },
};

interface VoiceSamplePreparation {
  register: 'email_casual';
  context: string;
  observedGeneration: string | null;
  embeddingSpaceKey: string;
  embedding: number[];
}

function voicePreparation(value: unknown): VoiceSamplePreparation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.register !== 'email_casual' ||
    row.context !== 'inbound-email' ||
    !(row.observedGeneration === null || typeof row.observedGeneration === 'string') ||
    typeof row.embeddingSpaceKey !== 'string' ||
    !Array.isArray(row.embedding) ||
    row.embedding.length < 1 ||
    row.embedding.length > MAX_EMBEDDING_DIMENSIONS ||
    !row.embedding.every((part) => typeof part === 'number' && Number.isFinite(part))
  )
    return null;
  return row as unknown as VoiceSamplePreparation;
}

const ownerVoiceObserver: InboundEmailObserver = {
  identity: { key: 'google.owner-voice-sample', version: 1, workClass: 'paid_ambiguous' },
  prepare: async (services, source, _claim) => {
    if (
      source.ingestMode !== 'direct' ||
      source.sourceVerification !== 'authenticated' ||
      !source.authenticated ||
      source.contentTrust !== 'owner' ||
      source.hasExternalOrUnknown
    )
      return { kind: 'no_op' };
    const text = source.body.trim();
    if (text.length < MIN_SAMPLE_CHARS || text.length > MAX_SAMPLE_CHARS) return { kind: 'no_op' };
    const voice = services.persistence.voiceContext;
    if (!voice) return { kind: 'no_op' };
    try {
      const observedGeneration = await voice.observationGeneration();
      if ((await voice.countSamplesWithContextPrefix(AUTO_SAMPLE_PREFIX)) >= MAX_AUTO_SAMPLES)
        return { kind: 'no_op' };
      const space = await services.router.embeddingSpace();
      const embeddingSpaceKey = embeddingSpaceIdentityKey(space);
      if (await voice.hasSampleText(text, embeddingSpaceKey)) return { kind: 'no_op' };
      const [embedding] = await services.router.embed([text], { expectedSpace: space });
      if (
        !embedding ||
        embedding.length !== space.dimensions ||
        embedding.length > MAX_EMBEDDING_DIMENSIONS
      )
        return { kind: 'unknown', errorCode: 'voice_embedding_unavailable' };
      validateEmbedding(space, embedding);
      return {
        kind: 'prepared',
        result: {
          register: 'email_casual',
          context: 'inbound-email',
          observedGeneration,
          embeddingSpaceKey,
          embedding,
        } satisfies VoiceSamplePreparation,
      };
    } catch {
      return { kind: 'unknown', errorCode: 'voice_embedding_unknown' };
    }
  },
  apply: async (services, source, claim, result) => {
    const prepared = voicePreparation(result);
    const voice = services.persistence.voiceContext;
    if (!prepared || !voice) return { kind: 'unknown', errorCode: 'voice_result_invalid' };
    try {
      // A crash after addSample but before observer completion is safe: the
      // text/space duplicate check turns the replay into a no-op.
      if (await voice.hasSampleText(source.body.trim(), prepared.embeddingSpaceKey))
        return { kind: 'complete' };
      await voice.addSample(
        {
          register: prepared.register,
          text: source.body.trim(),
          context: `${AUTO_SAMPLE_PREFIX}${prepared.context}`,
          embedding: prepared.embedding,
          embeddingSpaceKey: prepared.embeddingSpaceKey,
        },
        prepared.observedGeneration,
        {
          emailObserverEffectFence: {
            id: claim.id,
            agentId: claim.agentId,
            claimToken: claim.claimToken,
            claimGeneration: claim.claimGeneration,
            expectedPrivacyGeneration: claim.privacyGeneration,
          },
        },
      );
      return { kind: 'complete' };
    } catch {
      return { kind: 'unknown', errorCode: 'voice_sample_write_unknown' };
    }
  },
};

const attachmentObserver: InboundEmailObserver = {
  identity: { key: 'google.email-attachments', version: 3, workClass: 'idempotent_db' },
  prepare: async () => ({ kind: 'no_op' }),
  apply: async () => ({ kind: 'unknown', errorCode: 'attachment_client_missing' }),
};

export function googleDurableEmailObservers(client: GoogleClient): readonly InboundEmailObserver[] {
  const attachments: InboundEmailObserver = {
    ...attachmentObserver,
    shouldRun: (services) => services.config.ASSISTANT_MODULES.includes('documents'),
    prepare: async (services, source, claim) => {
      if (!services.config.ASSISTANT_MODULES.includes('documents')) return { kind: 'no_op' };
      if (
        source.ingestMode === 'direct' &&
        (!source.authenticated || !['owner', 'known'].includes(source.contentTrust))
      )
        return { kind: 'no_op' };
      if (source.ingestMode === 'forwarded') {
        const ingest = await services.persistence.emailSync?.ingestRecord(claim.channelMessageId);
        if (!ingest || ingest.importance <= 1) return { kind: 'no_op' };
      }
      const messageId = providerMessageId(claim.channelMessageId);
      if (!messageId) return { kind: 'unknown', errorCode: 'email_provider_id_invalid' };
      try {
        const message = await client.api<{ payload?: GmailPayload }>(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full&fields=id,threadId,internalDate,labelIds,snippet,payload`,
          { signal: AbortSignal.timeout(30_000) },
        );
        const manifest = preparedEmailAttachmentManifest(message.payload);
        return {
          kind: 'prepared',
          result: { messageId, manifestDigest: manifest.digest, entries: manifest.entries },
        };
      } catch {
        return { kind: 'unknown', errorCode: 'attachment_ingest_retryable' };
      }
    },
    apply: async (services, source, claim, result) => {
      try {
        if (!isValidEmailObserverPreparedResult('google.email-attachments', result))
          return { kind: 'unknown', errorCode: 'attachment_ingest_retryable' };
        await fileEmailAttachmentsForObserver(
          services,
          client,
          source,
          claim,
          result as EmailAttachmentPreparedResult,
        );
        return { kind: 'complete' };
      } catch {
        return { kind: 'retryable_failed', errorCode: 'attachment_ingest_retryable' };
      }
    },
  };
  return [
    cardObserver,
    applicationConfirmationObserver,
    directEmailRoutingObserver,
    ownerVoiceObserver,
    attachments,
  ];
}
