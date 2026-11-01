/** Explicit operator-only subpath. No application composition imports this module. */
import { randomUUID } from 'node:crypto';
import { ownerEditorPrivacyDigest, parseOwnerEditorEpochCursor } from '@assistant/persistence';
import type { DocumentSnapshot, Transaction } from '@google-cloud/firestore';
import { buildFirestoreOwnerEditorEpochRecord } from './owner-editor-epoch-record.js';
import { ownerEditorFirestorePrivacyToken } from './owner-editor-repository.js';
import { documentKey, type InstallationStore } from './store.js';

export const OWNER_EDITOR_MAINTENANCE_PRIVACY_BINDING =
  'owner-editor-privacy-v1/native-seconds-nanos';
type State = ReturnType<typeof parseOwnerEditorEpochCursor>;
export interface OwnerEditorMaintenancePacket {
  format: 1;
  privacyBinding: typeof OWNER_EDITOR_MAINTENANCE_PRIVACY_BINDING;
  operationId: string;
  action: 'initialize' | 'disable';
  releaseSha: string;
  target: {
    projectId: 'bmson-assistant';
    databaseId: 'assistant-production';
    installationId: string;
    ownerId: string;
  };
  issuedAt: number;
  expiresAt: number;
  proposedEpoch: string;
  expectedOwnerVersion: string;
  expectedPrivacyDigest: string;
  expectedEpoch: { version: string; state: State } | null;
  evidence: { recoverySha256: string; drainSha256: string } | null;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = /^[a-f0-9]{64}$/;
function fail(): never {
  throw new Error('Editor maintenance preconditions are unproven');
}
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  if (Object.keys(value).sort().join(',') !== keys.sort().join(',')) return fail();
  return value as Record<string, unknown>;
}
function validVersion(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = /^(-?\d{1,12}):(\d{1,9})$/.exec(value);
  return !!m && Number(m[2]) < 1e9;
}
function version(doc: DocumentSnapshot) {
  if (!doc.updateTime) return fail();
  return `${doc.updateTime.seconds}:${doc.updateTime.nanoseconds}`;
}
export function parseOwnerEditorMaintenancePacket(value: unknown): OwnerEditorMaintenancePacket {
  const p = exact(value, [
    'format',
    'privacyBinding',
    'operationId',
    'action',
    'releaseSha',
    'target',
    'issuedAt',
    'expiresAt',
    'proposedEpoch',
    'expectedOwnerVersion',
    'expectedPrivacyDigest',
    'expectedEpoch',
    'evidence',
  ]);
  const t = exact(p.target, ['projectId', 'databaseId', 'installationId', 'ownerId']);
  if (
    p.format !== 1 ||
    p.privacyBinding !== OWNER_EDITOR_MAINTENANCE_PRIVACY_BINDING ||
    typeof p.operationId !== 'string' ||
    !uuid.test(p.operationId) ||
    !['initialize', 'disable'].includes(String(p.action)) ||
    typeof p.releaseSha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(p.releaseSha) ||
    t.projectId !== 'bmson-assistant' ||
    t.databaseId !== 'assistant-production' ||
    typeof t.installationId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(t.installationId) ||
    typeof t.ownerId !== 'string' ||
    !uuid.test(t.ownerId) ||
    typeof p.proposedEpoch !== 'string' ||
    !uuid.test(p.proposedEpoch) ||
    !Number.isSafeInteger(p.issuedAt) ||
    !Number.isSafeInteger(p.expiresAt) ||
    (p.expiresAt as number) <= (p.issuedAt as number) ||
    (p.expiresAt as number) - (p.issuedAt as number) > 1800000 ||
    !validVersion(p.expectedOwnerVersion) ||
    typeof p.expectedPrivacyDigest !== 'string' ||
    !hash.test(p.expectedPrivacyDigest)
  )
    return fail();
  if (p.expectedEpoch !== null) {
    const expected = exact(p.expectedEpoch, ['version', 'state']);
    if (!validVersion(expected.version)) return fail();
    const state = parseOwnerEditorEpochCursor(expected.state);
    if (
      state.ownerId !== t.ownerId ||
      state.epoch === p.proposedEpoch ||
      (p.action === 'initialize' ? state.ready : !state.ready)
    )
      return fail();
  } else if (p.action !== 'initialize') return fail();
  if (p.evidence !== null) {
    const evidence = exact(p.evidence, ['recoverySha256', 'drainSha256']);
    if (!Object.values(evidence).every((v) => typeof v === 'string' && hash.test(v))) return fail();
  }
  return value as OwnerEditorMaintenancePacket;
}
function assertStore(store: InstallationStore, packet: OwnerEditorMaintenancePacket) {
  const t = packet.target;
  if (
    store.projectId !== t.projectId ||
    store.databaseId !== t.databaseId ||
    store.installationId !== t.installationId
  )
    fail();
}
async function observe(tx: Transaction, store: InstallationStore, ownerId: string) {
  const owners = await tx.get(store.collection('agents').select('id').limit(2));
  const owner = owners.docs[0];
  if (
    owners.size !== 1 ||
    !owner ||
    owner.id !== documentKey(ownerId) ||
    owner.get('id') !== ownerId
  )
    return fail();
  const [job, epoch] = await tx.getAll(
    store.doc('privacyErasureJobs', ownerId),
    store.doc('maintenanceCursors', `owner-editor-epoch:${ownerId}`),
    { fieldMask: ['agentId', 'status', 'generation', 'name', 'cursor'] },
  );
  if (!job || !epoch) return fail();
  const privacyGeneration = ownerEditorFirestorePrivacyToken(job, ownerId);
  let current: { version: string; state: State } | null = null;
  if (epoch.exists) {
    if (
      epoch.get('name') !== `owner-editor-epoch:${ownerId}` ||
      typeof epoch.get('cursor') !== 'string'
    )
      return fail();
    const state = parseOwnerEditorEpochCursor(JSON.parse(epoch.get('cursor')));
    if (state.ownerId !== ownerId) return fail();
    current = { version: version(epoch), state };
  }
  return {
    ownerVersion: version(owner),
    privacyGeneration,
    privacyDigest: ownerEditorPrivacyDigest(privacyGeneration),
    current,
  };
}
/** Read-only transaction; generates a durable proposal outside transaction retries. */
export async function prepareOwnerEditorMaintenance(
  store: InstallationStore,
  input: {
    ownerId: string;
    action: 'initialize' | 'disable';
    releaseSha: string;
    now: number;
  },
): Promise<OwnerEditorMaintenancePacket> {
  const proposedEpoch = randomUUID(),
    operationId = randomUUID();
  const observed = await store.db.runTransaction((tx) => observe(tx, store, input.ownerId), {
    readOnly: true,
  });
  const packet = parseOwnerEditorMaintenancePacket({
    format: 1,
    privacyBinding: OWNER_EDITOR_MAINTENANCE_PRIVACY_BINDING,
    operationId,
    action: input.action,
    releaseSha: input.releaseSha,
    target: {
      projectId: store.projectId,
      databaseId: store.databaseId,
      installationId: store.installationId,
      ownerId: input.ownerId,
    },
    issuedAt: input.now,
    expiresAt: input.now + 1800000,
    proposedEpoch,
    expectedOwnerVersion: observed.ownerVersion,
    expectedPrivacyDigest: observed.privacyDigest,
    expectedEpoch: observed.current,
    evidence: null,
  });
  assertStore(store, packet);
  return packet;
}
/** Exact CAS and stable proposal; this is the only initializer write boundary. */
export async function runOwnerEditorMaintenance(
  store: InstallationStore,
  raw: unknown,
  input: {
    mode: 'dry-run' | 'apply';
    releaseSha: string;
    now: () => number;
  },
) {
  const packet = parseOwnerEditorMaintenancePacket(raw);
  assertStore(store, packet);
  if (!['dry-run', 'apply'].includes(input.mode) || input.releaseSha !== packet.releaseSha)
    return fail();
  const checkTime = () => {
    const at = input.now();
    if (at < packet.issuedAt || at >= packet.expiresAt) fail();
  };
  checkTime();
  return store.db.runTransaction(
    async (tx) => {
      checkTime();
      const seen = await observe(tx, store, packet.target.ownerId);
      if (
        seen.ownerVersion !== packet.expectedOwnerVersion ||
        seen.privacyDigest !== packet.expectedPrivacyDigest
      )
        return fail();
      const desired: State = {
        ownerId: packet.target.ownerId,
        epoch: packet.proposedEpoch,
        ready: packet.action === 'initialize',
        privacyGenerationDigest: seen.privacyDigest,
      };
      const same = (a: State, b: State) =>
        a.ownerId === b.ownerId &&
        a.epoch === b.epoch &&
        a.ready === b.ready &&
        a.privacyGenerationDigest === b.privacyGenerationDigest;
      if (seen.current && same(seen.current.state, desired))
        return { outcome: 'already_applied' as const, wrote: false };
      if (
        packet.expectedEpoch === null
          ? seen.current !== null
          : !seen.current ||
            seen.current.version !== packet.expectedEpoch.version ||
            !same(seen.current.state, packet.expectedEpoch.state)
      )
        return fail();
      checkTime();
      if (input.mode === 'dry-run')
        return { outcome: 'would_apply' as const, wrote: false, activationApprovalRequired: true };
      if (!packet.evidence) return fail();
      tx.set(
        store.doc('maintenanceCursors', `owner-editor-epoch:${packet.target.ownerId}`),
        buildFirestoreOwnerEditorEpochRecord({
          ownerId: packet.target.ownerId,
          epoch: packet.proposedEpoch,
          ready: desired.ready,
          privacyGeneration: seen.privacyGeneration,
          updatedAt: store.now(),
        }),
      );
      return { outcome: 'applied' as const, wrote: true };
    },
    input.mode === 'dry-run' ? { readOnly: true } : { maxAttempts: 1 },
  );
}
