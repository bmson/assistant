import type { EmbeddingSpace } from './embedding.js';
import type { Records } from './records.js';

export type ImportJobName = 'import.run' | 'voice.ingest';

/** Lease fence required for every durable import job mutation. */
export type ImportJobFence = {
  agentId: string;
  source: string;
  taskId: string;
  queueGeneration: number;
  leaseToken: string;
};

/** `tasks.state.plannerState.import`: the resumable backstory import checkpoint. */
export type ImportRunCursor = {
  windowIndex: number;
  saved: number;
  duplicates: number;
  tombstoned: number;
  quarantined: number;
  occasionsSaved: number;
  manifestPath?: string;
  manifestHash?: string;
};

/** `tasks.state.plannerState.voiceIngest`: the resumable voice-sample checkpoint. */
export type VoiceIngestCursor = {
  index: number;
  saved: number;
  duplicates: number;
  embeddingSpaceKey?: string;
};

export type ImportProgress = { progress: string; progressPercent: number };

/** Durable parser receipt; rejected inputs are represented by bounded offsets and issue codes. */
export type ImportArchiveDiagnostics = {
  format: 'mbox' | 'json' | 'text';
  supported: string[];
  acceptedUnits: number;
  rejectedUnits: number;
  partial: boolean;
  issues: Array<{ offset: number; code: string; message: string }>;
};

/** A hash-linked source unit supplied to the model for one imported memory. */
export type ImportUnitProvenance = {
  sourceOffset: number;
  unitOffset: number;
  observedAt: string | null;
  authorEmail: string | null;
  header: string;
  hasQuotedContent: boolean;
  unitTextHash: string;
};

/** One distilled fact from an import window, embedded in the configured space. */
export type ImportFactWrite = {
  content: string;
  contentHash: string;
  embedding: number[];
  embeddingSpaceKey: string;
  kind: string;
  domain: string | null;
  importance: number;
  confidence: string;
  quarantined: boolean;
  subjectContactId: string | null;
  validFrom: Date | null;
  /** All exact parsed units in the distillation window, not an asserted single source. */
  sourceUnitProvenance: ImportUnitProvenance[];
};

export type ImportOccasionWrite = {
  contactId: string;
  kind: string;
  label: string;
  month: number;
  day: number;
  year: number | null;
  notes: string;
  quarantined: boolean;
};

export type VoiceSampleWrite = { text: string; embedding: number[]; embeddingSpaceKey: string };

/**
 * Persistence boundary for the `import.run` and `voice.ingest` code jobs.
 * Every mutation must reject a stale task generation or lease, a foreign
 * owner, an active privacy erasure, and a source no longer linked to the
 * running task. A window's records and its advanced cursor commit atomically,
 * so a retry or reclaimed lease resumes exactly after the last committed one.
 */
export interface ImportJobRepository {
  readonly kind: 'import-job-repository';
  readonly embeddingSpace: EmbeddingSpace;
  /** The source and current task state, or null when the fence no longer holds. */
  load(fence: ImportJobFence): Promise<{ source: Records['importSources']; state: unknown } | null>;
  /** Serializes archive parsing across instances; false while another task holds it. */
  claimSnapshotSlot(fence: ImportJobFence, ttlMs: number): Promise<boolean>;
  releaseSnapshotSlot(fence: ImportJobFence): Promise<void>;
  /** Record each parsed snapshot asset before publishing it to the private workspace. */
  registerSnapshotAsset(fence: ImportJobFence, workspacePath: string): Promise<boolean>;
  /** Marks the source running with its total and records the task checkpoint. */
  begin(
    fence: ImportJobFence,
    input: {
      itemsTotal: number;
      state: unknown;
      parseDiagnostics?: ImportArchiveDiagnostics | null;
    } & ImportProgress,
  ): Promise<boolean>;
  /** Resolve (creating unknown people as needed) the contact for each subject. */
  resolveSubjects(
    fence: ImportJobFence,
    subjects: Array<{ subject: string; relationship?: string }>,
  ): Promise<Array<string | null>>;
  /**
   * Commit window `windowIndex`: new memories, occasions, and the cursor
   * advanced past it. Returns null when the fence or cursor no longer matches.
   */
  commitImportWindow(
    fence: ImportJobFence,
    input: {
      windowIndex: number;
      facts: ImportFactWrite[];
      occasions: ImportOccasionWrite[];
      describe: (cursor: ImportRunCursor) => ImportProgress;
    },
  ): Promise<ImportRunCursor | null>;
  ownerIdentity(fence: ImportJobFence): Promise<{ emails: string[]; names: string[] } | null>;
  /** The subset of `texts` already present in the owner's writing-sample corpus. */
  existingSampleTexts(
    fence: ImportJobFence,
    texts: string[],
    embeddingSpaceKey: string,
  ): Promise<Set<string>>;
  /** Commit voice samples `[index, nextIndex)` and the advanced cursor atomically. */
  commitVoiceBatch(
    fence: ImportJobFence,
    input: {
      index: number;
      nextIndex: number;
      register: string;
      context: string;
      samples: VoiceSampleWrite[];
      duplicates: number;
      describe: (cursor: VoiceIngestCursor) => ImportProgress;
    },
  ): Promise<VoiceIngestCursor | null>;
  finish(
    fence: ImportJobFence,
    input: { status: 'done' | 'failed'; error: string | null },
  ): Promise<boolean>;
}

export type ImportStartInput = {
  source: string;
  workspacePath: string;
  kind: string;
  job: ImportJobName;
  payload: Record<string, unknown>;
  budgetUsdLimit: string;
};

export type ImportDeletionAsset = { id: string; workspacePath: string };

/**
 * Owner import-source commands. Purge and delete remove the source's memories
 * together with their graph facts and invalidate the compiled owner card;
 * callers recompile it from `agentId` afterwards.
 */
export interface ImportCommandRepository {
  readonly kind: 'import-command-repository';
  start(input: ImportStartInput): Promise<{ sourceId: string; taskId: string }>;
  purge(source: string): Promise<{ agentId: string; purged: number }>;
  remove(
    source: string,
  ): Promise<{ agentId: string; purgedMemories: number; cleanupReady: boolean }>;
  pendingDeletionAssets(source: string): Promise<ImportDeletionAsset[]>;
  assetDeleted(source: string, id: string, workspacePath: string): Promise<void>;
  completeDeletion(source: string): Promise<void>;
  review(
    source: string,
    verdict: 'approve' | 'reject',
  ): Promise<{ agentId: string; reviewed: number }>;
}

export function isImportCommandRepository(value: unknown): value is ImportCommandRepository {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'import-command-repository'
  );
}
