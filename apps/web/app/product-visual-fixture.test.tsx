import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { UIMessage } from 'ai';
import { type ComponentType, createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { createProductVisualData, visualId, visualNow } from './product-visual-data';

/** Actual retained pages, with only their authenticated I/O seams replaced. */
const state = vi.hoisted(() => ({
  empty: false,
  path: '/goals',
  firestore: false,
  chatState: null as 'stage' | 'paper' | null,
}));
const data = () => createProductVisualData(state.empty);
const recalledMessages = (): UIMessage[] =>
  [
    {
      id: visualId,
      role: 'user',
      parts: [{ type: 'text', text: 'Keep planning our weekend.' }],
      metadata: { createdAt: visualNow },
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Sam prefers an easy walk. I’ll keep that in the plan.' },
        {
          type: 'recall',
          sources: [
            { date: '2026-09-12', label: 'Weekend preferences', kind: 'knowledge_graph', hops: 2 },
            { date: '2026-09-20', label: 'Earlier trip chat', kind: 'chat' },
          ],
        },
      ],
      metadata: { createdAt: visualNow },
    },
  ] as unknown as UIMessage[];
function clientPreview<Props extends object>(
  name: string,
  component: ComponentType<Props>,
  props: Props,
) {
  return createElement('div', {
    'data-qa-product': name,
    'data-qa-props': JSON.stringify(props),
    // A hydration host must not replace the chat's flex relationship with main.
    style: name === 'chat' ? { display: 'contents' } : undefined,
    // biome-ignore lint/security/noDangerouslySetInnerHtml: actual component markup with an isolated React useId prefix
    dangerouslySetInnerHTML: {
      __html: renderToString(createElement(component, props), {
        identifierPrefix: `qa-product-${name}-`,
      }),
    },
  });
}
const disabledActions = vi.hoisted(
  () => () =>
    new Proxy(
      {},
      {
        has: () => true,
        get: (_target, name) =>
          name === 'then'
            ? undefined
            : async () => {
                throw new Error('Synthetic visual fixture: writes are disabled.');
              },
      },
    ),
);
vi.mock('@/auth', () => ({
  requireOwner: async () => ({}),
  isAuthed: async () => ({ user: { name: 'Synthetic owner', email: 'owner@example.test' } }),
  authMode: 'passkey',
}));
vi.mock('next/navigation', () => ({
  usePathname: () => state.path,
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
  notFound: () => {
    throw new Error('QA_NOT_FOUND');
  },
  redirect: (href: string) => {
    throw new Error(`QA_REDIRECT:${href}`);
  },
}));
vi.mock('@assistant/config', async () => ({
  ...(await vi.importActual('@assistant/config')),
  loadConfig: () => ({
    PERSISTENCE_DRIVER: state.firestore ? 'firestore' : 'postgres',
    FIRESTORE_AGENT_ID: visualId,
    GCP_PROJECT: 'synthetic-preview',
    ASSISTANT_WORKSPACE_ID: 'qa',
    MODULES: ['documents'],
    PUBLIC_URL: 'https://assistant.example',
  }),
  validateAgentPersistenceConfig: () => [],
  isModuleEnabled: () => true,
}));
vi.mock('@/lib/ui', async () => {
  // Ignored baseline files are optional; ordinary tests and CI import the real current primitives.
  if (process.env.PRODUCT_VISUAL_QA_BEFORE === '1')
    return vi.importActual(
      path.resolve(process.cwd(), '.workspace/ui-review-2026-10-03/baseline/ui.tsx'),
    );
  return vi.importActual('@/lib/ui');
});
vi.mock('@/app/actions', disabledActions);
vi.mock('@/app/chat/actions', disabledActions);
vi.mock('@/app/tasks/actions', disabledActions);
vi.mock('@/app/goals/actions', disabledActions);
vi.mock('@/app/approvals/actions', disabledActions);
vi.mock('@/app/anomalies/actions', disabledActions);
vi.mock('@/app/improvements/actions', disabledActions);
vi.mock('@/app/improvements/repair-actions', disabledActions);
vi.mock('@/app/profile/actions', disabledActions);
vi.mock('@/app/profile/knowledge/actions', disabledActions);
vi.mock('@/app/people/actions', disabledActions);
vi.mock('@/app/cards/actions', disabledActions);
vi.mock('@/app/calls/actions', disabledActions);
vi.mock('@/app/costs/actions', disabledActions);
vi.mock('@/app/documents/actions', disabledActions);
vi.mock('@/app/import/actions', disabledActions);
vi.mock('@/app/skills/actions', disabledActions);
vi.mock('@/app/suggestions/actions', disabledActions);
vi.mock('@/app/auto-refresh', () => ({ AutoRefresh: () => null }));
vi.mock('@/app/skills/skills-panel', async () => {
  const actual = await vi.importActual<typeof import('./skills/skills-panel')>(
    '@/app/skills/skills-panel',
  );
  return {
    ...actual,
    SkillsPanel: (props: Parameters<typeof actual.SkillsPanel>[0]) =>
      clientPreview('skills', actual.SkillsPanel, props),
  };
});
vi.mock('@/app/profile/voice-profile-form', async () => {
  const actual = await vi.importActual<typeof import('./profile/voice-profile-form')>(
    '@/app/profile/voice-profile-form',
  );
  return {
    ...actual,
    VoiceProfileForm: (props: Parameters<typeof actual.VoiceProfileForm>[0]) =>
      clientPreview('voice', actual.VoiceProfileForm, props),
  };
});
vi.mock('@/app/improvements/repair-panel', async () => {
  const actual = await vi.importActual<typeof import('./improvements/repair-panel')>(
    '@/app/improvements/repair-panel',
  );
  return {
    ...actual,
    RepairPanel: (props: Parameters<typeof actual.RepairPanel>[0]) =>
      clientPreview('repairs', actual.RepairPanel, props),
  };
});
vi.mock('@/app/chat/[id]/chat-client', async () => {
  const actual = await vi.importActual<typeof import('./chat/[id]/chat-client')>(
    '@/app/chat/[id]/chat-client',
  );
  return {
    ...actual,
    ChatClient: (props: Parameters<typeof actual.ChatClient>[0]) =>
      process.env.PRODUCT_VISUAL_QA_CHAT === '1'
        ? clientPreview('chat', actual.ChatClient, props)
        : createElement(actual.ChatClient, props),
  };
});
vi.mock('@/lib/approval-store', () => ({ getApprovalStore: () => ({}) }));
vi.mock('@/lib/server', () => ({
  getEmailObligationRepository: () => ({ listEmailObligations: async () => [] }),
  // Page query seams receive an opaque handle; any unexpected actual query fails closed.
  getDb: () =>
    new Proxy(
      {},
      {
        get: () => {
          throw new Error('Visual fixtures must not query a database.');
        },
      },
    ),
  getAgentTimezone: async () => 'America/Los_Angeles',
  getAgentIdentity: async () => ({ id: visualId, name: 'Assistant' }),
  getGeneratedCards: () => ({}),
  getCallsPorts: async () => ({}),
  getBillingOverview: async () => data().billing,
  getApplication: () => ({
    listClosedCommitments: async () =>
      state.empty
        ? []
        : [
            {
              id: visualId,
              kind: 'task',
              title: 'Send the revised draft',
              details: 'The draft was sent.',
              nextAction: '',
              dueAt: null,
              status: 'resolved',
              updatedAt: new Date(visualNow),
            },
          ],
    getDocuments: async () => ({
      documents: state.empty
        ? []
        : [
            {
              id: visualId,
              title: 'Apartment lease',
              mime: 'application/pdf',
              source: 'upload',
              trust: 'owner',
              status: 'ready',
              extractor: 'pdf',
              chunkCount: 12,
              bytes: 42800,
              error: null,
              createdAt: new Date(visualNow),
            },
          ],
      stats: {
        total: state.empty ? 0 : 1,
        ready: state.empty ? 0 : 1,
        chunks: state.empty ? 0 : 12,
        pending: 0,
      },
      primaryConversationId: visualId,
    }),
    getImports: async () => ({
      sources: state.empty
        ? []
        : [
            {
              id: visualId,
              source: 'Old work email',
              workspacePath: 'import/work-email.mbox',
              kind: 'email',
              status: 'done',
              itemsTotal: 42,
              itemsProcessed: 42,
              memoriesSaved: 18,
              taskId: visualId,
              error: null,
              updatedAt: new Date(visualNow),
            },
          ],
      quarantineBySource: { 'Old work email': 2 },
      unstartedFiles: state.empty ? [] : [{ name: 'family-notes.txt', dir: false }],
      sourcePagination: { consistency: 'live-keyset', hasMore: false, nextCursor: null },
      filesPagination: { consistency: 'process-snapshot', hasMore: false, nextCursor: null },
      sourceAvailability: { status: 'available', version: 1 },
      filesAvailability: { status: 'available', version: 1 },
    }),
    listSkills: async () =>
      state.empty
        ? []
        : [
            {
              id: visualId,
              name: 'Plan a weekend away',
              preconditions: 'When the owner asks for a short family trip.',
              steps:
                'Confirm dates and budget. Offer two places with travel times. Ask before booking.',
              gotchas: 'Leave space for rest and unplanned time.',
              ownerAuthored: true,
              deprecated: false,
              useCount: 3,
              successCount: 2,
              failureCount: 0,
              createdAt: new Date(visualNow),
            },
          ],
  }),
  getChatApplication: () => ({
    getPrimaryConversationId: async () => visualId,
    getChatConversation: async (id: string) => ({
      conversation: {
        id,
        title: state.chatState === 'paper' ? 'Notifications' : 'Family weekend',
        modelOverride: null,
        archivedAt: null,
        isPrimary: state.path === '/chat',
      },
      agentName: 'Assistant',
      agentTimezone: 'America/Los_Angeles',
      messages: state.chatState ? recalledMessages() : data().messages,
      models: [{ id: 'synthetic-model', label: 'Assistant default' }],
      goalTitle: undefined,
      canArchive: true,
      asyncTurn: state.chatState ? { taskId: visualId, cursor: 'synthetic-cursor' } : undefined,
      cursor: null,
    }),
    listChatHistory: async () => ({
      conversations: state.empty
        ? []
        : [
            {
              id: visualId,
              title: 'Main thread',
              isPrimary: true,
              createdAt: new Date(visualNow),
              updatedAt: new Date(visualNow),
              lastReadAt: new Date(visualNow),
            },
            {
              id: '00000000-0000-4000-8000-000000000002',
              title: 'Plan the family weekend',
              isPrimary: false,
              createdAt: new Date('2026-10-02T19:00:00Z'),
              updatedAt: new Date(visualNow),
              lastReadAt: null,
            },
          ],
      archivedCount: state.empty ? 0 : 2,
      totalInScope: state.empty ? 0 : 2,
      activeConversationIds: ['00000000-0000-4000-8000-000000000002'],
    }),
  }),
}));
vi.mock('@assistant/application/approvals', () => ({
  listApprovalInbox: async () => data().approval,
}));
vi.mock('@assistant/application/imports', () => ({
  getImportOverview: async () => {
    throw new Error('Firestore import reads are outside this presentation fixture.');
  },
}));
vi.mock('@assistant/application/cards', () => ({
  listSavedCards: async () => data().cards,
}));
vi.mock('@assistant/application/calls', () => ({
  listCalls: async () => data().calls,
  getCall: async () =>
    data().calls[0] ?? {
      ...createProductVisualData(false).calls[0],
      transcript: [],
      notes: [],
      checkins: [],
      summary: null,
    },
}));
vi.mock('@assistant/application/costs', () => ({
  getCostsDashboard: async () => data().costs,
}));
vi.mock('@assistant/application/goals', () => ({
  listGoalsDashboard: async () => data().goals,
}));
vi.mock('@assistant/application/people', () => ({
  listPeopleDirectory: async () => data().people,
  getPersonDossier: async () => data().dossier,
}));
vi.mock('@assistant/application/profile', () => ({
  getMemoryHubOverview: async () => data().hub,
  getOwnerFactsView: async () => data().about,
  getVoiceOverview: async () => data().voice,
  listMemoryLibrary: async () => data().library,
  listMemoryLibraryFilters: async () => ({
    subjects: [data().owner],
    domains: ['home', 'preferences'],
    sources: [],
  }),
}));
vi.mock('@assistant/application/commitments', () => ({
  listCommitmentOverview: async () => data().commitments,
}));
vi.mock('@assistant/application', async () => ({
  ...(await vi.importActual('@assistant/core/memory/predicate-vocabulary')),
  asGraphEntityKind: (value: string) => value || undefined,
  visibleWorkspaceCapabilityModules: (modules: unknown[]) => modules,
  getKnowledgeGraphOverview: async () => data().graph,
  getKnowledgeCleanupFindings: async () => data().findings,
  getKnowledgeWorkspaceOverview: async () => data().workspace,
  getKnowledgeMapSnapshot: async () => data().map,
}));
vi.mock('@assistant/firestore', () => ({
  createInstallationStore: () => ({ db: { terminate: async () => {} } }),
  FirestoreProfileMemoryHubRepository: class {},
}));
vi.mock('@assistant/application/tasks', () => ({
  terminalTaskStatuses: ['done', 'failed', 'cancelled'],
}));
vi.mock('@/lib/task-activity', () => ({
  listTaskActivity: async () => data().activity,
  getTaskActivityDetail: async () => data().task,
}));
vi.mock('@/lib/workspace-reviews', () => ({
  listOpenAnomalies: async () =>
    state.empty
      ? []
      : [
          {
            id: visualId,
            kind: 'volume_spike',
            toolName: 'gmail.send',
            detail: 'This policy approved more messages than usual overnight.',
            observed: '12',
            expected: '2',
            toolCallIds: [visualId],
            policyId: visualId,
            createdAt: new Date(visualNow),
          },
        ],
  listOpenImprovements: async () =>
    state.empty
      ? []
      : [
          {
            id: visualId,
            kind: 'behavior',
            title: 'Use a shorter summary for routine updates',
            rationale: 'Recent updates repeated details that were already visible in the card.',
            change: { suggestion: 'Lead with what changed and the decision needed.' },
            evidenceIds: [visualId],
            createdAt: new Date(visualNow),
          },
        ],
}));
vi.mock('@/lib/self-repair-server', () => ({
  getSelfRepairOverview: async () => ({
    enabled: true,
    configured: true,
    dailyLimit: 2,
    issues: state.empty
      ? []
      : [
          {
            id: visualId,
            title: 'Keep a hotel card after a partial lookup failure',
            summary:
              'A completed calendar read should remain visible when another source is unavailable.',
            status: 'testing',
            diagnosis: 'Preserve validated source cards in the recovery path.',
            lastError: '',
            sourceTaskId: null,
            prUrl: null,
            runUrl: null,
            history: [],
          },
        ],
  }),
}));
vi.mock('@/lib/capabilities', async () => ({
  ...(await vi.importActual('@/lib/capabilities')),
  getCapabilityDiagnostics: async () => ({
    statusAvailable: true,
    diagnostics: [
      {
        module: 'documents',
        enabled: !state.empty,
        ready: !state.empty,
        detail: state.empty ? 'Enable document reading in Settings.' : 'Document reading is ready.',
      },
    ],
  }),
}));
vi.mock('@/app/packs/actions', () => ({
  changePack: async () => ({ ok: false, error: 'Synthetic preview only.' }),
  loadPacks: async () => ({
    packs: state.empty
      ? []
      : [
          {
            id: visualId,
            title: 'Family weekend',
            version: 1,
            affectedIds: [],
            changes: [],
            data: {
              items: [
                {
                  id: 'hotel',
                  lane: 'plan',
                  title: 'Confirm our hotel arrival',
                  details: 'The front desk can hold our room until 10 PM.',
                  dependsOn: [],
                  needsReview: false,
                },
              ],
              decisions: [],
            },
          },
        ],
    sources: [],
  }),
}));

type PageEntry = {
  name: string;
  route: string;
  module: string;
  query?: Record<string, string>;
  empty?: boolean;
  chatState?: 'stage' | 'paper';
};
const products: PageEntry[] = [
  { name: 'anomalies', route: '/anomalies', module: './anomalies/page' },
  { name: 'approvals', route: '/approvals', module: './approvals/page' },
  { name: 'calls', route: '/calls', module: './calls/page' },
  { name: 'call-detail', route: `/calls/${visualId}`, module: './calls/[id]/page', empty: false },
  { name: 'capabilities', route: '/capabilities', module: './capabilities/page', empty: false },
  { name: 'cards', route: '/cards', module: './cards/page' },
  { name: 'chat', route: '/chat', module: './chat/page' },
  { name: 'side-chat', route: `/chat/${visualId}`, module: './chat/[id]/page' },
  { name: 'chats', route: '/chat/all', module: './chat/all/page' },
  { name: 'costs', route: '/costs', module: './costs/page' },
  { name: 'documents', route: '/documents', module: './documents/page' },
  { name: 'goals', route: '/goals', module: './goals/page' },
  { name: 'import', route: '/import', module: './import/page' },
  { name: 'improvements', route: '/improvements', module: './improvements/page' },
  { name: 'packs', route: '/packs', module: './packs/page' },
  { name: 'people', route: '/people', module: './people/page' },
  {
    name: 'person-detail',
    route: `/people/${visualId}`,
    module: './people/[id]/page',
    empty: false,
  },
  { name: 'memory', route: '/profile', module: './profile/page' },
  { name: 'about', route: '/profile/about', module: './profile/about/page' },
  { name: 'data', route: '/profile/data', module: './profile/data/page', empty: false },
  {
    name: 'knowledge',
    route: '/profile/knowledge',
    module: './profile/knowledge/page',
    query: { view: 'library' },
  },
  {
    name: 'knowledge-map',
    route: '/profile/knowledge?view=map',
    module: './profile/knowledge/page',
    query: { view: 'map' },
  },
  {
    name: 'knowledge-cleanup',
    route: '/profile/knowledge?view=cleanup',
    module: './profile/knowledge/page',
    query: { view: 'cleanup' },
  },
  { name: 'memory-read-only', route: '/profile/memories', module: './profile/memories/page' },
  { name: 'writing-voice', route: '/profile/voice', module: './profile/voice/page' },
  { name: 'skills', route: '/skills', module: './skills/page' },
  { name: 'activity', route: '/tasks', module: './tasks/page' },
  {
    name: 'activity-detail',
    route: `/tasks/${visualId}`,
    module: './tasks/[id]/page',
    empty: false,
  },
];

async function fixtureLayout(children: ReactNode) {
  if (process.env.PRODUCT_VISUAL_QA_BEFORE === '1') {
    const base = path.resolve(process.cwd(), '.workspace/ui-review-2026-10-03/baseline');
    // Resolve copied local imports without changing any frozen JSX or style class.
    const original = readFileSync(path.join(base, 'layout.tsx'), 'utf8');
    const resolved = original
      .replaceAll("'./admin-navigation'", "'@/app/admin-navigation'")
      .replaceAll("'./appearance-control'", "'@/app/appearance-control'")
      .replaceAll("'./globals.css'", "'@/app/globals.css'");
    writeFileSync(path.join(base, 'layout-resolved.tsx'), resolved);
    const module = await import(/* @vite-ignore */ path.join(base, 'layout-resolved.tsx'));
    return module.default({ children });
  }
  const { default: Layout } = await import('./layout');
  return Layout({ children });
}

const afterOnlyChatStates: PageEntry[] =
  process.env.PRODUCT_VISUAL_QA_CHAT_STATES === '1'
    ? [
        {
          name: 'chat-recall-failure',
          route: '/chat',
          module: './chat/page',
          empty: false,
          chatState: 'stage',
        },
        {
          name: 'notification-recall-failure',
          route: `/chat/${visualId}`,
          module: './chat/[id]/page',
          empty: false,
          chatState: 'paper',
        },
      ]
    : [];
const fixtureStates = [...products, ...afterOnlyChatStates].flatMap((page) =>
  (page.empty === false ? [false] : [false, true]).map((empty) => ({
    ...page,
    empty,
    name: `${page.name}${empty ? '-empty' : ''}`,
    productName: page.name,
  })),
);

it.each(fixtureStates)(
  'renders $name without accounts or persistence',
  async (page) => {
    const directory = process.env.PRODUCT_VISUAL_QA_DIR;
    state.empty = page.empty;
    state.path = page.route.split('?')[0];
    state.firestore = page.productName === 'memory-read-only';
    state.chatState = page.chatState ?? null;
    if (directory) process.stdout.write(`Rendering ${page.name}\n`);
    const { default: Page } = await import(page.module);
    const child = await Page({
      params: Promise.resolve({ id: visualId }),
      searchParams: Promise.resolve(page.query ?? {}),
    });
    const html = renderToString(await fixtureLayout(child));
    expect(html, page.name).toContain('id="main-content"');
    if (
      process.env.PRODUCT_VISUAL_QA_CHAT === '1' &&
      (['chat', 'side-chat'].includes(page.productName) || page.chatState)
    )
      expect(html, page.name).toContain('data-qa-product="chat"');
    // Chat uses its actual conversational header and accessible composer instead of an h1.
    if (page.productName !== 'chat') expect(html, page.name).toMatch(/<h1|aria-label="Message/);
    if (page.chatState) {
      expect(html).toContain('Drawing on knowledge graph and earlier chats');
      expect(html).toContain('2-hop connection');
      expect(html).toContain('Earlier trip chat');
      expect(html).toContain('Stop this task');
      if (page.chatState === 'paper') expect(html).toContain('data-decision-card="true"');
    }
    if (directory) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, `${page.name}.html`), `<!doctype html>${html}`);
    }
  },
  30_000,
);

it('accounts for all34 source routes and asserts the legacy person redirect', async () => {
  const directory = process.env.PRODUCT_VISUAL_QA_DIR;
  const manifest: Array<Record<string, unknown>> = fixtureStates.map((page) => ({
    name: page.name,
    route: page.route,
    source: `apps/web/app/${page.module.slice(2)}.tsx`,
    state: page.chatState
      ? `${page.chatState}-recall-with-failed-stop`
      : page.empty
        ? 'empty'
        : 'loaded',
    availability: 'retained-product-redirected-by-proxy',
    evidence:
      'Actual source component with synthetic read dependencies; not a navigable product route.',
    persistenceFixture:
      page.productName === 'memory-read-only'
        ? 'Firestore read-only branch'
        : 'PostgreSQL presentation branch',
  }));
  const { default: LegacyPerson } = await import('./profile/people/[id]/page');
  await expect(LegacyPerson({ params: Promise.resolve({ id: visualId }) })).rejects.toThrow(
    `QA_REDIRECT:/people/${visualId}`,
  );
  manifest.push({
    name: 'legacy-person',
    route: '/profile/people/[id]',
    source: 'apps/web/app/profile/people/[id]/page.tsx',
    availability: 'retained-redirect-only-alias',
    destination: '/people/[id]',
    evidence: 'Redirect source asserted; destination screenshots are person-detail.',
  });
  const pageFiles = (folder: string): string[] =>
    readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? pageFiles(path.join(folder, entry.name))
        : entry.name === 'page.tsx'
          ? [path.join(folder, entry.name)]
          : [],
    );
  const all = pageFiles(path.resolve(process.cwd(), 'apps/web/app'));
  expect(all).toHaveLength(34);
  const rendered = new Set(
    products.map((entry) => path.resolve('apps/web/app', `${entry.module.slice(2)}.tsx`)),
  );
  const consoleFiles = [
    'page.tsx',
    'settings/page.tsx',
    'security/page.tsx',
    'signin/page.tsx',
    'setup/page.tsx',
    'audit/page.tsx',
    'audit/[id]/page.tsx',
  ];
  const covered = new Set([
    ...rendered,
    ...consoleFiles.map((file) => path.resolve('apps/web/app', file)),
    path.resolve('apps/web/app/profile/people/[id]/page.tsx'),
  ]);
  expect(all.filter((file) => !covered.has(file))).toEqual([]);
  if (directory)
    writeFileSync(
      path.join(directory, 'manifest.json'),
      `${JSON.stringify(
        {
          sourcePageCount: all.length,
          reachableConsolePages: 6,
          rootRedirect: '/settings',
          retainedProductSourcePages: 27,
          before: process.env.PRODUCT_VISUAL_QA_BEFORE === '1',
          pages: manifest,
        },
        null,
        2,
      )}\n`,
    );
}, 30_000);
