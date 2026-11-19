import { randomUUID } from 'node:crypto';
import type { GoogleCalendarConnectionRepository } from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './client.js';
import { createPostgresGoogleCalendarConnectionRepository } from './google-calendar-connection-repository.js';
import { agents } from './schema.js';
import { exportWorkspaceSnapshot } from './workspace-migration.js';

describe('PostgreSQL personal Calendar connection', () => {
  let db: Db;
  let owner: string;
  let repo: GoogleCalendarConnectionRepository;
  let reopened: GoogleCalendarConnectionRepository;
  beforeEach(async () => {
    const url = process.env.DATABASE_URL;
    if (!url || !new URL(url).pathname.endsWith('_test'))
      throw Error('Requires isolated _test database');
    db = createDb(url);
    owner = randomUUID();
    await db.insert(agents).values({
      id: owner,
      name: 'Calendar OAuth test',
      email: `${owner}@example.invalid`,
      workspacePrefix: owner,
    });
    repo = createPostgresGoogleCalendarConnectionRepository(db);
    reopened = createPostgresGoogleCalendarConnectionRepository(db);
  });
  afterEach(async () => {
    if (db && owner) await db.delete(agents).where(eq(agents.id, owner));
  });

  it('persists expiry, single-use claims, and disconnect fences across repository instances', async () => {
    const flow = {
      id: randomUUID(),
      stateHash: 'a'.repeat(64),
      verifierEncrypted: 'sealed-verifier',
      nonce: 'nonce',
      expiresAt: '2026-11-14T13:00:00Z',
      outcome: 'pending' as const,
    };
    await repo.begin(owner, flow);
    const claims = await Promise.all([
      repo.consume(owner, flow.id, flow.stateHash, new Date('2026-11-14T12:00:00Z')),
      reopened.consume(owner, flow.id, flow.stateHash, new Date('2026-11-14T12:00:00Z')),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claimed = required(claims.find(Boolean));
    await reopened.disconnect(owner);
    expect(
      await repo.finish(
        owner,
        flow.id,
        claimed.revision,
        'connected',
        null,
        new Date('2026-11-14T12:01:00Z'),
      ),
    ).toBe(false);
    expect((await repo.get(owner))?.connection).toBeNull();
    expect((await repo.get(owner))?.flow?.verifierEncrypted).toBeNull();
    await repo.begin(owner, { ...flow, id: randomUUID() });
    const current = required(required(await repo.get(owner)).flow);
    expect(
      await reopened.consume(
        owner,
        current.id,
        current.stateHash,
        new Date('2026-11-14T13:00:00Z'),
      ),
    ).toBeNull();
    expect((await repo.get(owner))?.flow?.outcome).toBe('expired');
    expect(await repo.get(randomUUID())).toBeNull();
  });

  it('serializes refresh claims without disturbing pending reconnect or stable identity', async () => {
    const at = new Date('2026-11-14T12:00:00Z');
    const flow = {
      id: randomUUID(),
      stateHash: 'b'.repeat(64),
      verifierEncrypted: 'sealed-verifier',
      nonce: 'nonce',
      expiresAt: '2026-11-14T13:00:00Z',
      outcome: 'pending' as const,
    };
    await repo.begin(owner, flow);
    const claimed = await repo.consume(owner, flow.id, flow.stateHash, at);
    if (!claimed) throw new Error('Expected initial flow claim');
    const credential = {
      id: flow.id,
      credentialVersion: 0,
      accessTokenEncrypted: null,
      accessTokenExpiresAt: null,
      refreshLease: null,
      account: { subject: 'subject', email: 'owner@example.com' },
      refreshTokenEncrypted: 'sealed-refresh',
      scopes: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.readonly'],
      status: 'connected' as const,
      connectedAt: at.toISOString(),
    };
    expect(await repo.finish(owner, flow.id, claimed.revision, 'connected', credential, at)).toBe(
      true,
    );
    const pending = { ...flow, id: randomUUID(), stateHash: 'c'.repeat(64) };
    await reopened.begin(owner, pending);
    const pendingClaim = await repo.consume(owner, pending.id, pending.stateHash, at);
    if (!pendingClaim) throw new Error('Expected reconnect claim');
    const leaseId = randomUUID();
    const claims = await Promise.all([
      repo.acquireRefresh(owner, credential.id, leaseId, at, false),
      reopened.acquireRefresh(owner, credential.id, randomUUID(), at, false),
    ]);
    expect(claims.map((claim) => claim.kind).sort()).toEqual(['claimed', 'wait']);
    // Recover the winning lease from persisted state, independent of scheduling.
    const active = (await repo.get(owner))?.connection;
    if (!active?.refreshLease) throw new Error('Expected refresh lease');
    expect(
      await reopened.completeRefresh(
        owner,
        credential.id,
        active.refreshLease.id,
        active.credentialVersion,
        {
          ...active,
          refreshTokenEncrypted: 'sealed-rotated',
          accessTokenEncrypted: 'sealed-access',
          accessTokenExpiresAt: '2026-11-14T14:00:00Z',
        },
      ),
    ).toBe(true);
    expect((await repo.get(owner))?.revision).toBe(pendingClaim.revision);
    expect(await repo.finish(owner, pending.id, pendingClaim.revision, 'denied', null, at)).toBe(
      true,
    );
    expect((await repo.get(owner))?.connection).toMatchObject({
      id: credential.id,
      refreshTokenEncrypted: 'sealed-rotated',
    });
    const lease = await reopened.acquireRefresh(owner, credential.id, randomUUID(), at, true);
    if (lease.kind !== 'claimed' || !lease.credential.refreshLease)
      throw new Error('Expected forced lease');
    await repo.disconnect(owner);
    expect(
      await reopened.completeRefresh(
        owner,
        credential.id,
        lease.credential.refreshLease.id,
        lease.credential.credentialVersion,
        lease.credential,
      ),
    ).toBe(false);
    expect(await repo.get(owner)).toMatchObject({ adopted: true, connection: null });
  });
  it('exports durable personal consent and encrypted flow state with owner-scoped migration coverage', async () => {
    const flow = {
      id: randomUUID(),
      stateHash: 'd'.repeat(64),
      verifierEncrypted: 'sealed-verifier',
      nonce: 'nonce',
      expiresAt: '2026-11-14T13:00:00Z',
      outcome: 'pending' as const,
    };
    await repo.begin(owner, flow);
    const bundle = await exportWorkspaceSnapshot({
      databaseUrl: required(process.env.DATABASE_URL),
      agentId: owner,
      target: {
        projectId: 'demo-assistant-test',
        databaseId: '(default)',
        installationId: 'calendar-migration-test',
      },
      tables: ['agents', 'google_calendar_connections'],
    });
    const record = required(
      bundle.records.find((item) => item.table === 'google_calendar_connections'),
    );
    expect(record.id).toBe(owner);
    expect(record.collection).toBe('googleCalendarConnections');
    expect(record.data).toMatchObject({
      agentId: owner,
      state: { ownerId: owner, flow: { verifierEncrypted: 'sealed-verifier', id: flow.id } },
    });
  });
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Expected fixture value');
  return value;
}
