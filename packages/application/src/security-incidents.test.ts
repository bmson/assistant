import type { EmailSyncRepository } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { decideOwnerSecurityIncident, listOwnerSecurityReviews } from './security-incidents.js';

const incidentId = 'a3128194-69b2-5f49-96fa-0e1fab70eef2';

describe('owner security incident review use cases', () => {
  it('returns the bounded safe projection and lets delivered current revisions be reviewed', async () => {
    const repository = {
      listSecurityReviewItems: vi.fn().mockResolvedValue([
        {
          channelMessageId: 'private-source-key',
          incidentId,
          revision: 2,
          confidence: 'provider-reference',
          disposition: 'unreviewed',
          decisionRevision: null,
          materialChangeReason: 'new device',
          observedAt: new Date('2026-10-06T18:00:00Z'),
          category: 'security',
          importance: 3,
          subject: 'New sign-in',
          fromName: 'Security',
          evidence: {
            evidenceQuote: 'A new sign-in occurred.',
            privateMemo: 'must not escape',
            rawBody: 'source body must not escape',
          } as never,
          rawBody: 'private body must stay inside persistence',
        },
      ]),
    } as unknown as EmailSyncRepository;

    await expect(listOwnerSecurityReviews(repository, 'owner', 10)).resolves.toEqual([
      {
        incidentId,
        revision: 2,
        confidence: 'provider-reference',
        disposition: 'unreviewed',
        category: 'security',
        importance: 3,
        subject: 'New sign-in',
        fromName: 'Security',
        observedAt: '2026-10-06T18:00:00.000Z',
        materialChangeReason: 'new device',
        evidence: { evidenceQuote: 'A new sign-in occurred.' },
      },
    ]);
    expect(repository.listSecurityReviewItems).toHaveBeenCalledWith('owner', 10);
  });

  it('drops non-allowlisted evidence keys and excludes oversized quote text', async () => {
    const repository = {
      listSecurityReviewItems: vi.fn().mockResolvedValue([
        {
          incidentId,
          revision: 1,
          confidence: 'source-message',
          disposition: 'unreviewed',
          category: 'security',
          importance: 3,
          subject: 'New sign-in',
          fromName: null,
          observedAt: new Date('2026-10-06T18:00:00Z'),
          materialChangeReason: null,
          evidence: { evidenceQuote: 'x'.repeat(601), debug: 'private' },
        },
      ]),
    } as unknown as EmailSyncRepository;
    const [item] = await listOwnerSecurityReviews(repository, 'owner');
    expect(item?.evidence).toBeNull();
  });

  it('keeps long source labels reviewable with bounded visible summaries', async () => {
    const repository = {
      listSecurityReviewItems: vi.fn().mockResolvedValue([
        {
          channelMessageId: 'private-source-key',
          incidentId,
          revision: 3,
          confidence: 'C'.repeat(100),
          disposition: 'unreviewed',
          category: 'K'.repeat(140),
          importance: 4,
          subject: 'S'.repeat(350),
          fromName: 'F'.repeat(240),
          observedAt: new Date('2026-10-06T18:00:00Z'),
          materialChangeReason: 'M'.repeat(330),
          evidence: { eventType: 'Sign-in' },
          rawBody: 'private raw content',
        },
      ]),
    } as unknown as EmailSyncRepository;

    const [item] = await listOwnerSecurityReviews(repository, 'owner');
    expect(item).toMatchObject({
      confidence: `${'C'.repeat(79)}…`,
      category: `${'K'.repeat(119)}…`,
      subject: `${'S'.repeat(299)}…`,
      fromName: `${'F'.repeat(199)}…`,
      materialChangeReason: `${'M'.repeat(299)}…`,
      evidence: { eventType: 'Sign-in' },
    });
    expect(item?.subject).toHaveLength(300);
    expect(item).not.toHaveProperty('channelMessageId');
    expect(item).not.toHaveProperty('rawBody');
  });

  it('uses the configured owner and existing revision-compare decision contract', async () => {
    const repository = {
      decideSecurityIncident: vi.fn().mockResolvedValue(false),
    } as unknown as EmailSyncRepository;
    await expect(
      decideOwnerSecurityIncident(repository, 'owner', {
        incidentId,
        expectedRevision: 4,
        disposition: 'dismissed',
        reason: 'owner reviewed',
        now: new Date('2026-10-06T18:00:00Z'),
      }),
    ).resolves.toEqual({ ok: false });
    expect(repository.decideSecurityIncident).toHaveBeenCalledWith({
      agentId: 'owner',
      incidentId,
      expectedRevision: 4,
      disposition: 'dismissed',
      reason: 'owner reviewed',
      now: new Date('2026-10-06T18:00:00Z'),
    });
  });

  it('rejects invalid decision fields and unsafe list bounds before repository access', async () => {
    const repository = {
      listSecurityReviewItems: vi.fn(),
      decideSecurityIncident: vi.fn(),
    } as unknown as EmailSyncRepository;
    await expect(listOwnerSecurityReviews(repository, 'owner', 101)).rejects.toThrow(
      'Security review limit',
    );
    await expect(
      decideOwnerSecurityIncident(repository, 'owner', {
        incidentId,
        expectedRevision: 0,
        disposition: 'dismissed',
        reason: 'reviewed',
      }),
    ).rejects.toThrow('Invalid security incident decision');
    await expect(
      decideOwnerSecurityIncident(repository, 'owner', {
        incidentId,
        expectedRevision: -1,
        disposition: 'dismissed',
        reason: 'reviewed',
      }),
    ).rejects.toThrow('Invalid security incident decision');
    await expect(
      decideOwnerSecurityIncident(repository, 'owner', {
        incidentId: 'not-a-deterministic-uuid',
        expectedRevision: 1,
        disposition: 'dismissed',
        reason: 'reviewed',
      }),
    ).rejects.toThrow('Invalid security incident decision');
    expect(repository.listSecurityReviewItems).not.toHaveBeenCalled();
    expect(repository.decideSecurityIncident).not.toHaveBeenCalled();
  });
});
