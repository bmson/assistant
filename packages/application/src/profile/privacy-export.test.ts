import type { PrivacyExportRepository } from '@assistant/persistence';
import { describe, expect, it } from 'vitest';
import { createLongTermMemoryExporter } from './privacy-export.js';

describe('long-term memory export use case', () => {
  it('builds the stable owner-visible envelope without SQL', async () => {
    const data = {
      memories: [],
      knowledgeGraph: {
        entities: [],
        aliases: [],
        relations: [],
        assertions: [],
        assertionEvidence: [],
      },
      people: [],
      writingVoice: { samples: [], profile: null },
      compiledOwnerCard: null,
      situationPacks: [],
      emailObservers: { scope: 'observer-work-metadata-only' as const, rows: [] },
      directEmailRecovery: {
        scope: 'direct-ingest-routing-and-body-free-content-provenance' as const,
        rows: [],
      },
      missionReports: [],
      notificationOutbox: { scope: 'delivery-receipts-only' as const, rows: [] },
      recallSurfaces: { scope: 'source-identity-ledger-only' as const, rows: [] },
      securityIncidents: { incidents: [], sources: [], attention: [], evidence: [] },
    };
    const repository: PrivacyExportRepository = {
      kind: 'privacy-export-repository',
      exportOwnerData: async () => data,
    };
    const exportData = createLongTermMemoryExporter(
      repository,
      () => new Date('2026-09-19T20:00:00.000Z'),
    );

    await expect(exportData()).resolves.toEqual({
      format: 'assistant-long-term-memory-export/v1',
      exportedAt: '2026-09-19T20:00:00.000Z',
      scope: [
        'saved facts',
        'knowledge graph projections',
        'people profiles',
        'writing samples and voice profile',
        'compiled recall card',
        'situation packs and decision reasons',
        'durable mission reports and delivery receipts',
        'notification delivery receipts',
        'recall source identities and owner controls',
        'security incident evidence and attention history',
      ],
      ...data,
    });
  });
});
