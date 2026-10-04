/** Frozen synthetic presentation data. This module never opens a repository or account. */

import type {
  KnowledgeCleanupFinding,
  KnowledgeGraphOverview,
  KnowledgeMapSnapshot,
  KnowledgeWorkspaceOverview,
} from '@assistant/application';
import type { ApprovalInbox } from '@assistant/application/approvals';
import type { CallView } from '@assistant/application/calls';
import type { SavedCardView } from '@assistant/application/cards';
import type { CommitmentView } from '@assistant/application/commitments';
import type { CostsDashboard } from '@assistant/application/costs';
import type { GoalsDashboard } from '@assistant/application/goals';
import type { PersonDossier, PersonSummary } from '@assistant/application/people';
import type {
  MemoryHubOverview,
  MemoryLibrary,
  MemorySnapshot,
  OwnerFactsView,
  VoiceOverview,
} from '@assistant/application/profile';
import type { ProviderBilling } from '@assistant/application/provider-billing';
import type { ActivityList, TaskDetail } from '@assistant/application/tasks';
import type { UIMessage } from 'ai';

export const visualId = '00000000-0000-4000-8000-000000000001';
export const visualSecondId = '00000000-0000-4000-8000-000000000002';
export const visualNow = '2026-10-03T19:00:00.000Z';
const at = new Date('2026-10-03T18:00:00.000Z');
const owner = { id: visualId, name: 'Alex', aliases: [], relationship: '', trust: 'owner' };
const person = {
  id: visualSecondId,
  name: 'Sam Rivera',
  aliases: ['Sam'],
  relationship: 'friend',
  trust: 'known',
};

export function createProductVisualData(empty: boolean) {
  const memory: MemorySnapshot = {
    id: visualId,
    content: 'Alex lives in San Francisco and prefers a short, practical answer.',
    kind: 'fact',
    domain: 'home',
    confidence: '0.98',
    importance: 8,
    ownerConfirmed: true,
    pinned: true,
    lastConsolidatedAt: at,
    originTrust: 'owner',
    sourceTaskId: null,
    createdAt: at,
    validFrom: null,
    validUntil: null,
  };
  const health = {
    totalUsable: empty ? 0 : 124,
    notYetOrganized: empty ? 0 : 3,
    awaitingReview: empty ? 0 : 2,
    ownerConfirmed: empty ? 0 : 48,
    lastOrganizedAt: empty ? null : at,
  };
  const hub: MemoryHubOverview = {
    owner,
    quarantined: empty
      ? []
      : [
          {
            ...memory,
            ownerConfirmed: false,
            pinned: false,
            content: 'Sam may be planning a move to Oakland. This came from an imported email.',
          },
        ],
    memoryHealth: health,
    recallFeedback: {
      rated: empty ? 0 : 12,
      helpful: empty ? 0 : 10,
      notHelpful: empty ? 0 : 2,
      lastRatedAt: empty ? null : at,
      windowDays: 30,
    },
    latestOrganizer: empty
      ? null
      : { id: visualId, status: 'done', progress: 'Reviewed 18 recent facts.', updatedAt: at },
    card: empty ? null : { compiledAt: at, empty: false },
    ownerFactCount: empty ? 0 : 24,
    peopleCount: empty ? 0 : 8,
  };
  const about: OwnerFactsView = {
    owner,
    ownerFacts: empty
      ? []
      : [
          memory,
          {
            ...memory,
            id: visualSecondId,
            domain: 'preferences',
            content: 'Use plain language and show what needs my decision.',
          },
        ],
    card: empty
      ? null
      : {
          compiledAt: at,
          content:
            'Alex lives in San Francisco.\nPrefers practical answers and thoughtful reminders.\nAsk before sending messages or changing bookings.',
        },
    cardFactIds: empty ? [] : [visualId, visualSecondId],
  };
  const voice: VoiceOverview = {
    voiceStats: { total: empty ? 0 : 62, auto: empty ? 0 : 40, uploaded: empty ? 0 : 22 },
    voiceProfile: {
      description: empty ? '' : 'Warm, direct, and concise. Lead with the point.',
      dos: empty ? [] : ['Use short sentences', 'Be specific about the next step'],
      donts: empty ? [] : ['Avoid grand promises', 'Avoid unnecessary jargon'],
      signature: empty ? '' : 'Thanks, Alex',
    },
    voiceImports: empty
      ? []
      : [
          {
            source: 'Sent messages',
            status: 'done',
            itemsTotal: 22,
            itemsProcessed: 22,
            memoriesSaved: 22,
            taskId: visualId,
            error: null,
          },
        ],
  };
  const people: PersonSummary[] = empty
    ? []
    : [
        {
          ...person,
          group: 'friends',
          location: 'Oakland',
          factCount: 7,
          birthday: { month: 10, day: 12, year: 1991, daysUntil: 9, turningAge: 35 },
          lastContactAt: at,
        },
        {
          id: '00000000-0000-4000-8000-000000000003',
          name: 'Jordan Lee',
          relationship: 'colleague',
          trust: 'known',
          group: 'work',
          location: 'San Francisco',
          factCount: 3,
          birthday: null,
          lastContactAt: at,
        },
      ];
  const dossier: PersonDossier = {
    profile: {
      contact: person,
      facts: empty ? [] : [{ ...memory, content: 'Sam enjoys hiking and vegetarian cooking.' }],
      totalFacts: empty ? 0 : 1,
      occasions: empty
        ? []
        : [
            {
              id: visualId,
              kind: 'birthday',
              label: '',
              month: 10,
              day: 12,
              year: 1991,
              leadDays: 7,
              notes: 'Bring a small gift.',
              quarantined: false,
            },
          ],
      occasionSuggestions: [],
      mergeOptions: [],
    },
    group: 'friends',
    entityId: null,
    entity: null,
    location: empty ? null : 'Oakland',
    origins: [],
    relations: [],
    connections: [],
    events: empty
      ? []
      : [
          {
            id: visualId,
            content: 'Had lunch together and talked about the weekend hiking plan.',
            occurredAt: at,
            dateIsRecordTime: false,
            kind: 'episode',
            originTrust: 'owner',
          },
        ],
    lastContactAt: empty ? null : at,
    birthday: people[0]?.birthday ?? null,
    upcomingOccasion: empty
      ? null
      : { kind: 'birthday', label: '', daysUntil: 9, month: 10, day: 12 },
  };
  const goals: GoalsDashboard = {
    archivedCount: empty ? 0 : 2,
    items: empty
      ? []
      : [
          {
            goal: {
              id: visualId,
              title: 'Plan a relaxed family weekend',
              description: 'A two-night trip with time outdoors, without an overpacked schedule.',
              status: 'active',
              priority: 1,
              progress: 'Two places fit the dates. I am checking travel time.',
              nextAction: 'Choose between the coast and the mountains.',
              targetDate: new Date('2026-10-16T00:00:00Z'),
              createdAt: new Date('2026-09-28T00:00:00Z'),
              updatedAt: at,
              archivedAt: null,
              mirrorToPrimary: true,
              autonomy: false,
              taintedOrigin: false,
            },
            workActive: true,
            conversationId: visualSecondId,
            cadenceLabel: 'every day',
            blockedQuestion: '',
            stalled: false,
            automation: { enabled: true, nextRunAt: new Date('2026-10-04T18:00:00Z') },
          },
        ],
  };
  const activity: ActivityList = {
    archivedCount: empty ? 0 : 2,
    items: empty
      ? []
      : [
          {
            id: visualId,
            title: 'Prepare the family weekend',
            type: 'chat_turn',
            status: 'running',
            progress: 'Comparing two places with your travel preferences.',
            trust: 'owner',
            spentUsd: '0.018',
            budgetUsdLimit: '1.00',
            updatedAt: at,
            archivedAt: null,
            hasPendingApproval: false,
            hasActiveAutonomy: false,
            stuckWaiting: false,
          },
          {
            id: visualSecondId,
            title: 'Send the revised meeting agenda',
            type: 'chat_turn',
            status: 'waiting_approval',
            progress: 'Your draft is ready to review before I send it.',
            trust: 'owner',
            spentUsd: '0.005',
            budgetUsdLimit: '1.00',
            updatedAt: at,
            archivedAt: null,
            hasPendingApproval: true,
            hasActiveAutonomy: false,
            stuckWaiting: false,
          },
        ],
  };
  const task: TaskDetail = {
    timezone: 'America/Los_Angeles',
    task: {
      id: visualId,
      type: 'chat_turn',
      status: empty ? 'pending' : 'done',
      title: 'Find the hotel confirmation',
      trust: 'owner',
      spentUsd: empty ? '0' : '0.012',
      budgetUsdLimit: '1',
      updatedAt: at,
      deadline: null,
      nextAction: '',
      progress: empty ? '' : 'Found the confirmation and saved its booking details.',
      progressPercent: empty ? null : 100,
      plan: null,
      archivedAt: null,
    },
    toolCalls: [],
    modelCalls: [],
    approvals: [],
    messages: [],
    files: [],
    actions: empty
      ? []
      : [
          {
            id: visualId,
            toolName: 'gmail.read_thread',
            createdAt: at,
            finishedAt: at,
            completed: true,
            error: null,
            resultPreview: {
              text: '{ "hotel": "Harbor Hotel", "checkIn": "2026-10-16" }',
              truncated: false,
              totalChars: 60,
            },
          },
        ],
    hasMoreTimeline: false,
    activeGrant: null,
    stuckWaiting: false,
  };
  const calls: CallView[] = empty
    ? []
    : [
        {
          id: visualId,
          taskId: visualId,
          to: '+14155550100',
          contactName: 'Harbor Hotel',
          status: 'completed',
          active: false,
          outcome: 'success',
          summary: 'Late arrival is confirmed. The front desk will hold the room until 10 PM.',
          brief: {
            goal: 'Confirm a late check-in for Friday.',
            context: 'Booking reference QA-4826.',
            mayAgreeTo: 'A later check-in time.',
            mustNot: 'Change or cancel the booking.',
            language: 'English',
            onVoicemail: 'hang_up',
          },
          voiceModel: 'Synthetic voice',
          maxMinutes: 5,
          createdAt: at,
          startedAt: at,
          endedAt: at,
          durationSeconds: 94,
          costUsd: '0.08',
          error: null,
          notes: ['Bring a photo ID.'],
          checkins: [],
          openCheckin: null,
          transcript: [
            {
              role: 'assistant',
              text: 'Hello, I am an AI assistant calling for Alex about a late arrival.',
              at: visualNow,
            },
            {
              role: 'caller',
              text: 'We can hold the room until 10 PM. Please bring a photo ID.',
              at: visualNow,
            },
          ],
        },
      ];
  const cards: SavedCardView[] = empty
    ? []
    : [
        {
          id: visualId,
          revisionId: visualSecondId,
          status: 'active',
          conversationId: visualId,
          updatedAt: at,
          stale: false,
          refreshState: 'idle',
          spec: {
            version: 1,
            title: 'Harbor Hotel',
            subtitle: 'Your weekend booking',
            icon: 'hotel',
            accent: 'mint',
            accessibilityLabel: 'Harbor Hotel reservation, October 16 to 18',
            sourceLabel: 'Booking confirmation',
            facts: [
              {
                id: 'hotel',
                label: 'Hotel',
                value: 'Harbor Hotel',
                source: 'Booking confirmation',
                sensitive: false,
              },
              {
                id: 'dates',
                label: 'Dates',
                value: 'October 16–18',
                source: 'Booking confirmation',
                sensitive: false,
              },
              {
                id: 'address',
                label: 'Address',
                value: '12 Waterfront Road',
                source: 'Booking confirmation',
                sensitive: false,
              },
            ],
            blocks: [
              { type: 'hero', titleFact: 'hotel', subtitleFact: 'dates' },
              { type: 'facts', factIds: ['address'] },
            ],
            actions: [
              {
                id: 'ask',
                type: 'ask_assistant',
                label: 'Ask about this stay',
                prompt: 'What should I know about this hotel?',
              },
            ],
            refreshable: false,
          },
        },
      ];
  const commitments: CommitmentView[] = empty
    ? []
    : [
        {
          id: visualId,
          kind: 'waiting_on',
          title: 'Sam is checking which Saturday works for a hike',
          details: 'We talked about an easy morning route.',
          nextAction: 'Check back on Thursday if you have not heard.',
          dueAt: new Date('2026-10-08T18:00:00Z'),
          status: 'open',
        },
      ];
  const graph: KnowledgeGraphOverview = {
    totalEntities: empty ? 0 : 3,
    totalRelations: empty ? 0 : 2,
    unreviewedRelations: 0,
    pendingSources: 0,
    quarantinedSources: empty ? 0 : 1,
    pendingCostUsd: null,
    pendingRuns: 0,
    relativeDateSources: 0,
    entities: [],
    matchingEntities: 0,
    entityPage: 1,
    entityPages: 1,
    selected: null,
    relations: [],
    selectedRelationTotal: 0,
    selectedActiveRelationTotal: 0,
    duplicates: [],
  };
  const findings: KnowledgeCleanupFinding[] = empty
    ? []
    : [
        {
          id: visualId,
          kind: 'quarantined',
          title: 'Review a detail from an imported email',
          detail:
            'Sam may be moving to Oakland. Confirm the source before this shapes a conversation.',
          memoryId: visualId,
          relationId: null,
          count: 1,
        },
      ];
  const workspace: KnowledgeWorkspaceOverview = {
    memory: health,
    graph: {
      activeEntities: empty ? 0 : 3,
      activeRelations: empty ? 0 : 2,
      orphanedEntities: 0,
      pendingSources: 0,
      failedSources: 0,
    },
    cleanupCount: findings.length,
  };
  const map: KnowledgeMapSnapshot = {
    nodes: empty
      ? []
      : [
          {
            id: visualId,
            contactId: visualId,
            label: 'Alex',
            kind: 'person',
            component: 0,
            degree: 2,
          },
          {
            id: visualSecondId,
            contactId: visualSecondId,
            label: 'Sam Rivera',
            kind: 'person',
            component: 0,
            degree: 1,
          },
          { id: 'place', label: 'San Francisco', kind: 'place', component: 0, degree: 1 },
        ],
    edges: empty
      ? []
      : [
          {
            id: 'friend',
            subjectId: visualId,
            objectId: visualSecondId,
            predicate: 'knows',
            reviewStatus: 'confirmed',
            sourceMemoryId: visualId,
            sourceContent: 'Sam is Alex’s friend.',
            evidenceQuote: null,
            presentation: {
              sentence: 'Alex knows Sam Rivera.',
              label: 'Knows',
              accessibleLabel: 'Alex knows Sam Rivera.',
            },
            validFrom: null,
            validUntil: null,
          },
          {
            id: 'home',
            subjectId: visualId,
            objectId: 'place',
            predicate: 'lives_in',
            reviewStatus: 'confirmed',
            sourceMemoryId: visualId,
            sourceContent: 'Alex lives in San Francisco.',
            evidenceQuote: null,
            presentation: {
              sentence: 'Alex lives in San Francisco.',
              label: 'Lives in',
              accessibleLabel: 'Alex lives in San Francisco.',
            },
            validFrom: null,
            validUntil: null,
          },
        ],
    components: empty ? [] : [{ id: 0, nodes: 3, edges: 2, label: 'People and places' }],
    totalEdges: empty ? 0 : 2,
    truncated: false,
    filters: { query: '', kind: '', predicates: [], review: 'all', sourceMemoryId: '' },
  };
  const library: MemoryLibrary = {
    rows: empty
      ? []
      : [
          {
            memory,
            subjectId: owner.id,
            subjectLabel: owner.name,
            subjectTrust: owner.trust,
            connectionCount: 1,
            projectionStatus: 'connected',
          },
        ],
    total: empty ? 0 : 1,
    page: 1,
    totalPages: 1,
  };
  const costs: CostsDashboard = {
    timezone: 'America/Los_Angeles',
    totals: {
      dailySpentUsd: empty ? 0 : 0.32,
      monthlySpentUsd: empty ? 0 : 8.42,
      heldUsd: empty ? 0 : 0.12,
      dailyLimitUsd: 2,
      monthlyLimitUsd: 30,
      softPct: 80,
    },
    byEvidence: empty ? [] : [{ basis: 'token_rate', usd: '8.42', count: 128 }],
    bySource: empty ? [] : [{ source: 'Model calls', usd: '8.42', count: 128 }],
    byModel: empty ? [] : [{ model: 'Configured assistant model', usd: '8.42', count: 128 }],
    topTasks: empty
      ? []
      : [{ taskId: visualId, usd: '0.12', type: 'chat_turn', progress: 'Plan the family weekend' }],
    held: [],
    recent: [],
    parkedTasks: 0,
    taskDefaultLimit: '1',
  };
  const billing: ProviderBilling[] = [
    {
      id: 'synthetic-provider',
      label: 'AI provider',
      status: empty ? 'not_configured' : 'reported',
      period: '2026-10',
      scope: 'Assistant usage',
      source: 'Synthetic statement',
      message: empty
        ? 'Connect billing to see provider-reported charges.'
        : 'Charges reported by the provider. Usage caps are separate.',
      fetchedAt: empty ? null : visualNow,
      latestExportAt: null,
      latestUsageAt: null,
      lines: empty
        ? []
        : [
            {
              service: 'Model calls',
              detail: 'Assistant',
              currency: 'USD',
              cost: 8.42,
              credits: 0,
              net: 8.42,
            },
          ],
    },
  ];
  const messages: UIMessage[] = empty
    ? []
    : [
        {
          id: visualId,
          role: 'user',
          parts: [{ type: 'text', text: 'What needs my attention this afternoon?' }],
          metadata: { createdAt: visualNow },
        },
        {
          id: visualSecondId,
          role: 'assistant',
          parts: [
            {
              type: 'text',
              text: 'The meeting agenda is ready for your approval. Your hotel has confirmed a late arrival, and Sam is checking Saturday for the hike.',
            },
          ],
          metadata: { createdAt: visualNow },
        },
      ];
  const approval: ApprovalInbox = {
    pending: empty
      ? []
      : [
          {
            taskType: 'chat_turn',
            taskTrust: 'owner',
            toolName: 'gmail.send',
            decision: { reason: 'Sending a message needs your approval.' },
            approval: {
              id: visualId,
              taskId: visualSecondId,
              shortCode: 'QA7',
              summary: 'Send the revised meeting agenda to Jordan',
              toolCallId: visualId,
              payload: {
                to: 'jordan@example.test',
                subject: 'Friday meeting agenda',
                body: 'Hi Jordan, here is the revised agenda for Friday. We will review the project plan and agree on the next steps. Thanks, Alex',
              },
              resolutionPayload: null,
              status: 'pending',
              requestedAt: at,
              expiresAt: new Date('2026-10-04T19:00:00Z'),
              resolvedAt: null,
              resolvedVia: null,
              notifiedChannels: ['conversation'],
              createdPolicyId: null,
            },
          },
        ],
    resolved: [],
  };
  return {
    memory,
    owner,
    hub,
    about,
    voice,
    people,
    dossier,
    goals,
    activity,
    task,
    calls,
    cards,
    commitments,
    graph,
    findings,
    workspace,
    map,
    library,
    costs,
    billing,
    messages,
    approval,
  };
}
