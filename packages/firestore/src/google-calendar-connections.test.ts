import { randomUUID } from 'node:crypto';
import {
  GOOGLE_CALENDAR_READ_SCOPE,
  GOOGLE_CALENDAR_WRITE_SCOPE,
  type GoogleCalendarConnectionRepository,
} from '@assistant/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFirestoreGoogleCalendarConnectionRepository } from './google-calendar-connections.js';
import type { InstallationStore } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'Firestore personal Calendar connection',
  () => {
    let store: InstallationStore;
    let owner: string;
    let repo: GoogleCalendarConnectionRepository;
    let reopened: GoogleCalendarConnectionRepository;
    beforeEach(() => {
      store = emulatorStore();
      owner = randomUUID();
      repo = createFirestoreGoogleCalendarConnectionRepository(store);
      reopened = createFirestoreGoogleCalendarConnectionRepository(store);
    });
    afterEach(async () => disposeStore(store));

    it('retains a read grant through cancelled upgrades and fences an old refresh after a successful write upgrade', async () => {
      const at = new Date('2026-11-18T09:00:00Z');
      const initial = {
        id: randomUUID(),
        stateHash: 'c'.repeat(64),
        nonce: 'initial',
        verifierEncrypted: 'sealed',
        expiresAt: '2026-11-18T10:00:00Z',
        outcome: 'pending' as const,
      };
      await repo.begin(owner, initial);
      const claimed = required(await repo.consume(owner, initial.id, initial.stateHash, at));
      const credential = {
        id: initial.id,
        credentialVersion: 0,
        accessTokenEncrypted: 'sealed-read',
        accessTokenExpiresAt: '2026-11-18T11:00:00Z',
        refreshLease: null,
        account: { subject: 'subject', email: 'owner@example.com' },
        refreshTokenEncrypted: 'sealed-refresh',
        scopes: ['openid', 'email', GOOGLE_CALENDAR_READ_SCOPE],
        status: 'connected' as const,
        connectedAt: at.toISOString(),
      };
      expect(
        await repo.finish(owner, initial.id, claimed.revision, 'connected', credential, at),
      ).toBe(true);
      const upgrade = {
        ...initial,
        id: randomUUID(),
      };
      await repo.begin(owner, upgrade, credential.id);
      const cancelled = required(await reopened.consume(owner, upgrade.id, upgrade.stateHash, at));
      expect(await repo.cancel(owner, upgrade.id)).toBe(true);
      expect(
        await reopened.finish(
          owner,
          upgrade.id,
          cancelled.revision,
          'connected',
          { ...credential, scopes: [...credential.scopes, GOOGLE_CALENDAR_WRITE_SCOPE] },
          at,
        ),
      ).toBe(false);
      expect((await reopened.get(owner))?.connection).toEqual(credential);
      const next = { ...upgrade, id: randomUUID() };
      await reopened.begin(owner, next, credential.id);
      const nextClaim = required(await repo.consume(owner, next.id, next.stateHash, at));
      const leaseId = randomUUID();
      expect((await reopened.acquireRefresh(owner, credential.id, leaseId, at, true)).kind).toBe(
        'claimed',
      );
      expect(
        await repo.finish(
          owner,
          next.id,
          nextClaim.revision,
          'connected',
          {
            ...credential,
            scopes: [...credential.scopes, GOOGLE_CALENDAR_WRITE_SCOPE],
            refreshTokenEncrypted: 'sealed-write-refresh',
          },
          at,
          credential.id,
        ),
      ).toBe(true);
      expect(
        await reopened.completeRefresh(
          owner,
          credential.id,
          leaseId,
          credential.credentialVersion,
          credential,
        ),
      ).toBe(false);
      expect((await reopened.get(owner))?.connection).toMatchObject({
        id: credential.id,
        credentialVersion: 1,
        refreshLease: null,
        scopes: [...credential.scopes, GOOGLE_CALENDAR_WRITE_SCOPE],
      });
      await expect(
        repo.begin(owner, { ...upgrade, id: randomUUID() }, randomUUID()),
      ).rejects.toThrow('changed');
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
  },
);

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Expected fixture value');
  return value;
}
