import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  driver: 'postgres',
  auth: vi.fn(),
  getBillingOverview: vi.fn(),
  getFirestoreMobileWorkspace: vi.fn(),
  withPostgresMobileWorkspaceRead: vi.fn(),
  getCapabilityDiagnostics: vi.fn(),
}));

vi.mock('@assistant/application', () => ({ visibleWorkspaceCapabilityModules: () => [] }));
vi.mock('@assistant/config', () => ({ loadConfig: () => ({ PERSISTENCE_DRIVER: mocks.driver }) }));
vi.mock('@assistant/modules/meta', () => ({ assistantModuleMetas: [] }));
vi.mock('@/lib/agent-readiness-source', () => ({ getAgentReadinessSource: () => ({}) }));
vi.mock('@/lib/capabilities', () => ({
  capabilityStatus: () => 'unavailable',
  getCapabilityDiagnostics: mocks.getCapabilityDiagnostics,
}));
vi.mock('@/lib/firestore-mobile-workspace', () => ({
  getFirestoreMobileWorkspace: mocks.getFirestoreMobileWorkspace,
}));
vi.mock('@/lib/mobile-workspace-sections', () => ({
  readMobileWorkspaceSection: async (read: () => unknown) => ({
    value: await read(),
    availability: { status: 'available', version: 1 },
  }),
}));
vi.mock('@/lib/self-repair-server', () => ({ getSelfRepairOverview: async () => undefined }));
vi.mock('@/lib/server', () => ({
  getBillingOverview: mocks.getBillingOverview,
  MOBILE_BILLING_REFRESH_BUDGET_MS: 1,
  withPostgresMobileWorkspaceRead: mocks.withPostgresMobileWorkspaceRead,
}));
vi.mock('@/mobile-auth', () => ({
  isMobileAuthed: mocks.auth,
  mobileJson: (value: unknown, init?: ResponseInit) => Response.json(value, init),
  mobileUnauthorized: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));

import { GET } from './route';

const amountOnlyReport = {
  id: 'openai-billing',
  label: 'OpenAI organization',
  status: 'reported',
  period: '2026-09',
  periodTimezone: 'UTC',
  scope: 'Configured organization scope · Projects: proj_demo',
  source: 'OpenAI Costs API',
  message: 'Provider-reported cost for the selected project.',
  fetchedAt: '2026-09-16T00:00:00.000Z',
  checkedAt: '2026-09-16T00:00:00.000Z',
  amountBasis: 'provider_reported_cost',
  latestExportAt: null,
  latestUsageAt: null,
  lines: [
    {
      service: 'OpenAI',
      detail: 'proj_demo · Text input',
      currency: 'USD',
      cost: 1.25,
      credits: 0,
      net: 1.25,
      projectId: 'proj_demo',
    },
  ],
  forecast: {
    through: '2026-09-16',
    observedDays: 15,
    daysInMonth: 30,
    totals: [{ currency: 'USD', spent: 1.25, dailyAverage: 0.08, projected: 2.5 }],
    message: 'Observed-period run rate only.',
  },
};

const sectionAvailability = Object.fromEntries(
  [
    'chats',
    'memory',
    'skills',
    'capabilities',
    'settings',
    'costs',
    'billing',
    'anomalies',
    'improvements',
    'imports',
    'importSources',
    'importFiles',
    'repairs',
  ].map((key) => [key, { status: 'available', version: 1 }]),
);

const firestorePayload = () => ({
  sectionAvailability,
  costs: { billing: [amountOnlyReport], billingCoverage: { title: 'old coverage' } },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.driver = 'postgres';
  mocks.auth.mockResolvedValue(true);
  mocks.getCapabilityDiagnostics.mockResolvedValue(undefined);
  mocks.getBillingOverview.mockResolvedValue([amountOnlyReport]);
  mocks.getFirestoreMobileWorkspace.mockImplementation(async () => firestorePayload());
  const application = {
    getWorkspacePage: async () => ({ items: [], hasMore: false, nextCursor: null }),
    getProfileOverview: async () => undefined,
    getSettings: async () => undefined,
    getCostsDashboard: async () => undefined,
    getImports: async () => undefined,
  };
  mocks.withPostgresMobileWorkspaceRead.mockImplementation(
    async (read: (context: { ownerId: string; application: typeof application }) => unknown) =>
      read({ ownerId: 'owner-fixture', application }),
  );
});

describe('mobile workspace billing capability negotiation', () => {
  it.each(['postgres', 'firestore'])(
    '%s returns amount-only data only to an aware client',
    async (driver) => {
      mocks.driver = driver;
      const aware = await GET(
        new Request('https://example.test/api/mobile/v1/workspace', {
          headers: {
            'x-assistant-workspace-sections': '1',
            'x-assistant-billing-amounts': '1',
          },
        }),
      );
      const awareBilling = (await aware.json()).costs;
      expect(awareBilling.billing[0]).toMatchObject({
        status: 'reported',
        amountBasis: 'provider_reported_cost',
        lines: [{ cost: 1.25, currency: 'USD' }],
        forecast: { totals: [{ projected: 2.5 }] },
      });
      expect(
        awareBilling.billingCoverage.entries.find(
          (entry: { id: string }) => entry.id === 'openai-billing',
        ),
      ).toMatchObject({ state: 'partial' });

      for (const header of [undefined, 'future-version']) {
        const requestHeaders: Record<string, string> = { 'x-assistant-workspace-sections': '1' };
        if (header !== undefined) requestHeaders['x-assistant-billing-amounts'] = header;
        const legacy = await GET(
          new Request('https://example.test/api/mobile/v1/workspace', {
            headers: requestHeaders,
          }),
        );
        const legacyBilling = (await legacy.json()).costs;
        expect(legacyBilling.billing[0]).toMatchObject({
          status: 'unavailable',
          amountBasis: 'provider_reported_cost',
          lines: [],
          message: expect.stringContaining('Update the app to view the reported-cost breakdown.'),
        });
        expect(legacyBilling.billing[0].forecast).toBeUndefined();
        expect(JSON.stringify(legacyBilling.billing[0])).not.toContain('1.25');
        expect(
          legacyBilling.billingCoverage.entries.find(
            (entry: { id: string }) => entry.id === 'openai-billing',
          ),
        ).toMatchObject({ state: 'unknown' });
      }

      if (driver === 'postgres') expect(mocks.withPostgresMobileWorkspaceRead).toHaveBeenCalled();
      else expect(mocks.getFirestoreMobileWorkspace).toHaveBeenCalled();
    },
  );
});
