import type { EmailObserverEffectFence } from './generated-cards.js';

export interface VoiceProfileText {
  description: string;
  dos: string[];
  donts: string[];
  signature: string;
}

/**
 * The owner's writing voice for outbound rewrites (SMS, email): the stored
 * profile and the nearest writing samples of one register.
 */
export interface VoiceContextRepository {
  readonly kind: 'voice-context-repository';
  profile(): Promise<VoiceProfileText | null>;
  /** Whether any sample of the register exists, so a draft is embedded only when it can match. */
  hasSamples(register: string, embeddingSpaceKey: string): Promise<boolean>;
  /** Up to `limit` sample texts nearest the draft embedding. */
  nearestSamples(
    register: string,
    embedding: number[],
    embeddingSpaceKey: string,
    limit: number,
  ): Promise<string[]>;
  /** Whether a sample with exactly this text exists, whatever its register. */
  hasSampleText(text: string, embeddingSpaceKey: string): Promise<boolean>;
  /** Samples whose context starts with `prefix` (automatic captures). */
  countSamplesWithContextPrefix(prefix: string): Promise<number>;
  /** Owner privacy generation captured before reading text or invoking embedding. */
  observationGeneration(): Promise<string | null>;
  addSample(
    input: {
      register: string;
      text: string;
      context: string;
      embedding: number[];
      embeddingSpaceKey: string;
    },
    observedGeneration: string | null,
    options?: { emailObserverEffectFence?: EmailObserverEffectFence },
  ): Promise<void>;
}

/** Bind the saved sample to the current immutable observer preparation. */
export function emailObserverPreparedVoiceMatches(
  work: {
    agentId: string;
    claimToken: string | null;
    claimGeneration: number;
    privacyGeneration: string | null;
    status: string;
    leaseExpiresAt: Date | null;
    observerKey: string;
    observerVersion: number;
    sourceKind: string;
    preparedResult: unknown;
  },
  fence: EmailObserverEffectFence,
  input: {
    register: string;
    text: string;
    context: string;
    embedding: number[];
    embeddingSpaceKey: string;
  },
  observedGeneration: string | null,
  now: Date,
): boolean {
  if (
    work.agentId !== fence.agentId ||
    work.claimToken !== fence.claimToken ||
    work.claimGeneration !== fence.claimGeneration ||
    work.privacyGeneration !== fence.expectedPrivacyGeneration ||
    work.status !== 'prepared' ||
    !work.leaseExpiresAt ||
    work.leaseExpiresAt <= now ||
    work.observerKey !== 'google.owner-voice-sample' ||
    work.observerVersion !== 1 ||
    work.sourceKind !== 'message'
  )
    return false;
  if (
    !work.preparedResult ||
    typeof work.preparedResult !== 'object' ||
    Array.isArray(work.preparedResult)
  )
    return false;
  const prepared = work.preparedResult as Record<string, unknown>;
  return (
    prepared.observedGeneration === observedGeneration &&
    prepared.register === 'email_casual' &&
    prepared.context === 'inbound-email' &&
    input.register === prepared.register &&
    input.context === `auto:${prepared.context}` &&
    input.embeddingSpaceKey === prepared.embeddingSpaceKey &&
    input.text.length >= 80 &&
    input.text.length <= 4000 &&
    Array.isArray(prepared.embedding) &&
    prepared.embedding.length > 0 &&
    prepared.embedding.length <= 2048 &&
    prepared.embedding.every((part) => typeof part === 'number' && Number.isFinite(part)) &&
    JSON.stringify(input.embedding) === JSON.stringify(prepared.embedding)
  );
}

/** The email body is the sole stored text part; display headers are not source prose. */
export function emailObserverMessageBody(parts: unknown): string | null {
  if (!Array.isArray(parts)) return null;
  const texts = parts.filter((part) => part && typeof part === 'object' && part.type === 'text');
  return texts.length === 1 && typeof texts[0].text === 'string' ? texts[0].text : null;
}
