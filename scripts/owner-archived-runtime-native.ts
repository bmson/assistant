import { createHash } from 'node:crypto';
import type { ArchivedRoleEvidence } from './owner-archived-runtime-pack.js';
import {
  bootstrapDigest,
  object,
  RUN_ROOT,
  requireProof,
  SERVICE_ROOT,
} from './owner-release-current-snapshot.js';

const originalSource = '1c2ea3907bf17b14368846708002f9d4633f2092';
const originalManifest = '9ca6dcbb6a1c4b6e25ca6ea857c86ae1c3103a75d9a8e4e26af801f7b1c32647';
const roleNames = ['agent', 'web'] as const;
type Role = (typeof roleNames)[number];
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const hex = /^[a-f0-9]{64}$/;
type Obj = Record<string, unknown>;

function exact(value: unknown, keys: string[]): Obj {
  const row = object(value);
  requireProof(Object.keys(row).sort().join(',') === keys.sort().join(','));
  return row;
}

function text(value: unknown, pattern: RegExp): string {
  requireProof(typeof value === 'string' && pattern.test(value));
  return value;
}

function roleBinding(value: unknown, role: Role) {
  const b = exact(value, [
    'revision',
    'serviceUidSha256',
    'revisionUidSha256',
    'serviceSha256',
    'revisionSha256',
  ]);
  return {
    revision: text(b.revision, new RegExp(`^assistant-${role}-[a-z0-9-]{1,63}$`)),
    serviceUidSha256: text(b.serviceUidSha256, hex),
    revisionUidSha256: text(b.revisionUidSha256, hex),
    serviceSha256: text(b.serviceSha256, hex),
    revisionSha256: text(b.revisionSha256, hex),
  };
}

function settled(row: Obj) {
  requireProof(
    text(row.generation, /^[1-9][0-9]{0,18}$/) === row.observedGeneration &&
      (row.reconciling === undefined || row.reconciling === false) &&
      row.deleteTime === undefined &&
      row.expireTime === undefined,
  );
}

function singleton(value: unknown) {
  requireProof(Array.isArray(value) && value.length === 1);
  return object(value[0]);
}

function environment(value: unknown) {
  requireProof(Array.isArray(value));
  const rows = new Map<string, Obj>();
  for (const input of value) {
    const row = object(input);
    const name = text(row.name, /^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
    requireProof(!rows.has(name));
    rows.set(name, row);
  }
  return (name: string, pattern: RegExp) => {
    const row = exact(rows.get(name), ['name', 'value']);
    return text(row.value, pattern);
  };
}

/** Offsets live parent lookup for the explicit archived observer only. Evidence is
 * already verified by the pack reader. Native metadata drift requires new review. */
export async function observeArchivedRuntimePair(
  binding: unknown,
  roles: Record<Role, ArchivedRoleEvidence>,
  read: (url: string) => Promise<unknown>,
) {
  try {
    const packet = exact(binding, ['format', 'roles']);
    requireProof(packet.format === 1);
    const byRole = exact(packet.roles, [...roleNames]);
    // Validate the entire read set before making even a service GET.
    const reviewed = {
      agent: roleBinding(byRole.agent, 'agent'),
      web: roleBinding(byRole.web, 'web'),
    };
    for (const role of roleNames)
      requireProof(Buffer.isBuffer(roles[role]?.parent) && Buffer.isBuffer(roles[role]?.child));

    const observed = await Promise.all(
      roleNames.map(async (role) => {
        const b = reviewed[role];
        const serviceName = `${SERVICE_ROOT}${role}`;
        const revisionName = `${serviceName}/revisions/${b.revision}`;
        const [serviceValue, revisionValue] = await Promise.all([
          read(`${RUN_ROOT}${serviceName}`),
          read(`${RUN_ROOT}${revisionName}`),
        ]);
        const service = object(serviceValue);
        const revision = object(revisionValue);
        requireProof(
          bootstrapDigest(service) === b.serviceSha256 &&
            bootstrapDigest(revision) === b.revisionSha256 &&
            bootstrapDigest(text(service.uid, /^[a-f0-9-]{36}$/)) === b.serviceUidSha256 &&
            bootstrapDigest(text(revision.uid, /^[a-f0-9-]{36}$/)) === b.revisionUidSha256,
        );
        settled(service);
        settled(revision);
        requireProof(
          service.name === serviceName &&
            revision.name === revisionName &&
            (revision.service === serviceName || revision.service === `assistant-${role}`) &&
            service.latestCreatedRevision === revisionName &&
            service.latestReadyRevision === revisionName &&
            object(service.terminalCondition).state === 'CONDITION_SUCCEEDED' &&
            object(service.scaling).scalingMode === 'AUTOMATIC',
        );
        requireProof(Array.isArray(revision.conditions));
        const ready = revision.conditions.map(object).filter((row) => row.type === 'Ready');
        requireProof(singleton(ready).state === 'CONDITION_SUCCEEDED');
        for (const rows of [service.traffic, service.trafficStatuses]) {
          const row = singleton(rows);
          requireProof(
            row.type === 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION' &&
              row.revision === b.revision &&
              row.percent === 100 &&
              row.tag === undefined,
          );
        }
        const template = object(service.template);
        const account = `assistant-${role}@bmson-assistant.iam.gserviceaccount.com`;
        const requested = singleton(template.containers);
        const runtime = singleton(revision.containers);
        const status = singleton(revision.containerStatuses);
        const repository = `us-west1-docker.pkg.dev/bmson-assistant/assistant/${role}`;
        requireProof(
          template.revision === b.revision &&
            template.serviceAccount === account &&
            revision.serviceAccount === account &&
            requested.image === `${repository}@sha256:${digest(roles[role].parent)}` &&
            runtime.image === `${repository}@sha256:${digest(roles[role].child)}` &&
            runtime.name === `${role}-1` &&
            status.name === runtime.name &&
            status.imageDigest === runtime.image &&
            bootstrapDigest(requested.env) === bootstrapDigest(runtime.env),
        );
        const get = environment(runtime.env);
        requireProof(
          get('ASSISTANT_RELEASE_SOURCE_SHA', /^[a-f0-9]{40}$/) === originalSource &&
            get('ASSISTANT_RELEASE_MANIFEST', hex) === originalManifest &&
            get('ASSISTANT_RELEASE_API_CONTRACT', /^1$/) === '1' &&
            get('ASSISTANT_RELEASE_WRITES_PAUSED', /^false$/) === 'false' &&
            get('PERSISTENCE_DRIVER', /^firestore$/) === 'firestore' &&
            get('FIRESTORE_DATABASE_ID', /^assistant-production$/) === 'assistant-production',
        );
        return {
          serviceName,
          serviceSha256: b.serviceSha256,
          owner: get('FIRESTORE_AGENT_ID', /^[A-Za-z0-9_.:-]{1,128}$/),
          workspace: get('ASSISTANT_WORKSPACE_ID', /^[A-Za-z0-9_.:-]{1,128}$/),
        };
      }),
    );
    requireProof(
      observed[0]?.owner === observed[1]?.owner &&
        observed[0]?.workspace === observed[1]?.workspace,
    );
    await Promise.all(
      observed.map(async (item) => {
        const repeated = await read(`${RUN_ROOT}${item.serviceName}`);
        requireProof(bootstrapDigest(object(repeated)) === item.serviceSha256);
      }),
    );
    return {
      status: 'observed_archived_original_pair',
      source: originalSource,
      observedTemplateWritesPaused: false,
      routing: 'canonical_only',
      mutationAuthorized: false,
      trafficAuthorized: false,
    } as const;
  } catch {
    throw new Error('Archived runtime native pair is unproven');
  }
}
