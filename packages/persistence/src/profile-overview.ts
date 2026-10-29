/** Read model shared by the PostgreSQL and Firestore profile voice views. */
export interface ProfileVoiceOverview {
  voiceStats: { total: number; auto: number; uploaded: number };
  voiceProfile: { description: string; dos: string[]; donts: string[]; signature: string };
  voiceImports: Array<{
    source: string;
    status: string;
    itemsTotal: number | null;
    itemsProcessed: number;
    memoriesSaved: number;
    taskId: string | null;
    error: string | null;
  }>;
}

export interface ProfileVoiceOverviewRepository {
  readonly kind: 'profile-voice-overview-repository';
  load(): Promise<ProfileVoiceOverview>;
}

export function isProfileVoiceOverviewRepository(
  value: unknown,
): value is ProfileVoiceOverviewRepository {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'profile-voice-overview-repository' &&
    'load' in value &&
    typeof value.load === 'function'
  );
}

export interface ProfileMemoryHubOverview {
  owner?: {
    id: string;
    name: string;
    aliases: string[];
    relationship: string;
    trust: string;
    identityRevision?: string;
  };
  quarantined: Array<{
    id: string;
    content: string;
    kind: string;
    domain: string | null;
    confidence: string;
    importance: number;
    ownerConfirmed: boolean;
    pinned: boolean;
    lastConsolidatedAt: Date | null;
    originTrust: string;
    sourceTaskId: string | null;
    createdAt: Date;
    validFrom: Date | null;
    validUntil: Date | null;
  }>;
  memoryHealth: {
    totalUsable: number;
    notYetOrganized: number;
    awaitingReview: number;
    ownerConfirmed: number;
    lastOrganizedAt: Date | null;
  };
  recallFeedback: {
    rated: number;
    helpful: number;
    notHelpful: number;
    lastRatedAt: Date | null;
    windowDays: number;
  };
  latestOrganizer: { id: string; status: string; progress: string; updatedAt: Date } | null;
  card: { compiledAt: Date; empty: boolean } | null;
  ownerFactCount: number;
  peopleCount: number;
}

export interface ProfileMemoryHubRepository {
  readonly kind: 'profile-memory-hub-repository';
  load(): Promise<ProfileMemoryHubOverview>;
}

export function isProfileMemoryHubRepository(value: unknown): value is ProfileMemoryHubRepository {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'profile-memory-hub-repository' &&
    'load' in value &&
    typeof value.load === 'function'
  );
}

export type ProfileOverviewContact = NonNullable<ProfileMemoryHubOverview['owner']> & {
  identityRevision: string;
};

export type ProfileOverviewRead = Pick<
  ProfileMemoryHubOverview,
  'quarantined' | 'memoryHealth' | 'latestOrganizer'
> &
  ProfileVoiceOverview & {
    owner?: ProfileOverviewContact;
    people: Array<{ contact: ProfileOverviewContact; factCount: number }>;
    ownerFacts: ProfileMemoryHubOverview['quarantined'];
    card: { content: string; compiledAt: Date } | null;
  };

export interface ProfileOverviewRepository {
  readonly kind: 'profile-overview-repository';
  load(): Promise<ProfileOverviewRead>;
}

export function isProfileOverviewRepository(value: unknown): value is ProfileOverviewRepository {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'profile-overview-repository' &&
    'load' in value &&
    typeof value.load === 'function'
  );
}
