import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ports = vi.hoisted(() => ({
  owner: vi.fn(),
  getOwnerFactsView: vi.fn(),
  getDb: vi.fn(),
  getFirestoreInstallationStore: vi.fn(),
  readPrivacyErasureFence: vi.fn(),
  assertPrivacyErasureFenceUnchanged: vi.fn(),
  loadConfig: vi.fn(),
  validateAgentPersistenceConfig: vi.fn(),
  mutations: {
    approveQuarantined: vi.fn(),
    confirmFact: vi.fn(),
    correctFact: vi.fn(),
    createMemoryAction: vi.fn(),
    forgetFact: vi.fn(),
    recompileCard: '/offline-action',
    rejectQuarantined: vi.fn(),
    setFactProminence: vi.fn(),
  },
}));

vi.mock('@/auth', () => ({ requireOwner: ports.owner }));
vi.mock('@assistant/application/profile', () => ({ getOwnerFactsView: ports.getOwnerFactsView }));
vi.mock('@assistant/config', () => ({
  loadConfig: ports.loadConfig,
  validateAgentPersistenceConfig: ports.validateAgentPersistenceConfig,
}));
vi.mock('@assistant/firestore', () => ({
  assertPrivacyErasureFenceUnchanged: ports.assertPrivacyErasureFenceUnchanged,
  FirestoreProfilePeopleReadRepository: vi.fn(),
  readPrivacyErasureFence: ports.readPrivacyErasureFence,
}));
vi.mock('@/lib/server', () => ({
  getDb: ports.getDb,
  getFirestoreInstallationStore: ports.getFirestoreInstallationStore,
}));
vi.mock('@/app/profile/actions', () => ports.mutations);

import AboutYouPage from './page';

const db = Object.freeze({ fixture: 'read-only-profile-db' });
const owner = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Owner',
  aliases: [],
  relationship: 'self',
  trust: 'owner',
};
const ownerSnapshot = { id: owner.id, get: (key: string) => (key === 'id' ? owner.id : null) };
const firestoreStore = {
  collection: () => ({
    limit: () => ({ get: async () => ({ size: 1, docs: [ownerSnapshot] }) }),
  }),
  doc: (_collection: string, id: string) => ({ id }),
};
const fence = Object.freeze({ fixture: 'same-fence' });

function memory(overrides: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    content: 'A saved owner note.',
    kind: 'fact',
    domain: 'relationships',
    confidence: '0.9',
    importance: 3,
    ownerConfirmed: true,
    pinned: false,
    lastConsolidatedAt: null,
    originTrust: 'owner',
    sourceTaskId: null,
    createdAt: new Date('2024-03-01T12:00:00.000Z'),
    validFrom: null,
    validUntil: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  ports.owner.mockResolvedValue({ user: { email: 'offline-owner@example.test' } });
  ports.getDb.mockReturnValue(db);
  ports.loadConfig.mockReturnValue({ PERSISTENCE_DRIVER: 'postgres' });
  ports.validateAgentPersistenceConfig.mockReturnValue([]);
  ports.getFirestoreInstallationStore.mockReturnValue(firestoreStore);
  ports.readPrivacyErasureFence.mockResolvedValue(fence);
  ports.assertPrivacyErasureFenceUnchanged.mockResolvedValue(undefined);
});

describe('actual About page saved-note date rendering', () => {
  it.each(['postgres', 'firestore'] as const)(
    '%s page shows malformed dates as unavailable, preserves a known end, and leaves null bounds absent',
    async (driver) => {
      ports.loadConfig.mockReturnValue({
        PERSISTENCE_DRIVER: driver,
        FIRESTORE_AGENT_ID: owner.id,
      });
      const createdAt = new Date(Number.NaN);
      const validFrom = new Date(Number.NaN);
      const validUntil = new Date('2024-03-01T23:00:00.000Z');
      const malformed = Object.freeze(memory({ createdAt, validFrom, validUntil }));
      const noValidity = Object.freeze(
        memory({
          id: '33333333-3333-4333-8333-333333333333',
          content: 'A note with no recorded validity bounds.',
          validFrom: null,
          validUntil: null,
        }),
      );
      ports.getOwnerFactsView.mockResolvedValue({
        owner,
        ownerFacts: [malformed, noValidity],
        card: null,
        cardFactIds: [],
      });

      const html = renderToStaticMarkup(await AboutYouPage());

      expect(html).toContain('Saved Date unavailable');
      expect(html).toContain('date unavailable–2024-03-01');
      expect(html).toContain('A note with no recorded validity bounds.');
      expect(html.match(/date unavailable–/g)).toHaveLength(1);
      expect(html).not.toContain('–now');
      expect(html).not.toContain('NaN');
      expect(html).toContain('Add a fact about you');
      expect(html).toContain('Correct');
      expect(html).toContain('Forget');
      if (driver === 'postgres') {
        expect(ports.getDb).toHaveBeenCalledOnce();
        expect(ports.getOwnerFactsView).toHaveBeenCalledExactlyOnceWith(db);
        expect(ports.getFirestoreInstallationStore).not.toHaveBeenCalled();
      } else {
        expect(ports.getDb).not.toHaveBeenCalled();
        expect(ports.getFirestoreInstallationStore).toHaveBeenCalledOnce();
        expect(ports.readPrivacyErasureFence).toHaveBeenCalledOnce();
        expect(ports.assertPrivacyErasureFenceUnchanged).toHaveBeenCalledOnce();
        expect(ports.getOwnerFactsView).toHaveBeenCalledOnce();
      }
      expect(Object.isFrozen(malformed)).toBe(true);
      expect(Number.isNaN(createdAt.getTime())).toBe(true);
      expect(Number.isNaN(validFrom.getTime())).toBe(true);
      expect(validUntil.getTime()).toBe(new Date('2024-03-01T23:00:00.000Z').getTime());
      for (const action of Object.values(ports.mutations)) {
        if (typeof action === 'function') expect(action).not.toHaveBeenCalled();
      }
    },
  );
});
