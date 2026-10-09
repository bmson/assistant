import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  provisionTargetFirestoreIndexes,
  verifyConsumerIndexReadiness,
  waitForConsumerIndexReadiness,
} from './consumer-index-readiness.js';
import type { InstallationIdentity } from './installation-manifest.js';
import type { CommandRunner } from './runner.js';

const identity: InstallationIdentity = {
  installationId: 'consumer-install',
  projectId: 'customer-project',
  region: 'us-central1',
  databaseId: '(default)',
  release: {
    commitSha: '0123456789abcdef0123456789abcdef01234567',
    archiveDigest: `sha256:${'a'.repeat(64)}`,
  },
};
const specBytes = readFileSync('infra/gcp/firestore/firestore.indexes.json');
const spec = JSON.parse(specBytes.toString('utf8')) as {
  indexes: Array<{
    collectionGroup: string;
    queryScope: string;
    fields: Array<{
      fieldPath: string;
      order?: string;
      vectorConfig?: { dimension: number; flat: Record<string, never> };
    }>;
  }>;
  fieldOverrides: Array<{ collectionGroup: string; fieldPath: string }>;
};
const prefix = `projects/${identity.projectId}/databases/${identity.databaseId}/collectionGroups/`;

function liveIndexes(databaseId = identity.databaseId) {
  const databasePrefix = `projects/${identity.projectId}/databases/${databaseId}/collectionGroups/`;
  return spec.indexes.map((index, number) => {
    const fields = [...index.fields];
    const vectorPosition = fields.findIndex((field) => field.vectorConfig !== undefined);
    if (!fields.some((field) => field.fieldPath === '__name__')) {
      const documentName = {
        fieldPath: '__name__',
        order: index.fields.at(-1)?.order === 'DESCENDING' ? 'DESCENDING' : 'ASCENDING',
      };
      if (vectorPosition === fields.length - 1) fields.splice(vectorPosition, 0, documentName);
      else fields.push(documentName);
    }
    return {
      name: `${databasePrefix}${index.collectionGroup}/indexes/${number + 1}`,
      queryScope: index.queryScope,
      fields,
      state: 'READY',
    };
  });
}

function liveOverrides(databaseId = identity.databaseId) {
  const databasePrefix = `projects/${identity.projectId}/databases/${databaseId}/collectionGroups/`;
  return [
    {
      name: `${databasePrefix}__default__/fields/*`,
      indexConfig: { indexes: [] },
    },
    ...spec.fieldOverrides.map((field) => ({
      name: `${databasePrefix}${field.collectionGroup}/fields/${field.fieldPath}`,
      indexConfig: { indexes: [] },
    })),
  ];
}

function fakeLists(indexes: unknown, fields: unknown, calls: string[]): CommandRunner {
  return {
    async run(command, args) {
      calls.push([command, ...args].join(' '));
      if (args[2] === 'composite') return { ok: true, stdout: JSON.stringify(indexes), stderr: '' };
      if (args[2] === 'fields') return { ok: true, stdout: JSON.stringify(fields), stderr: '' };
      return { ok: false, stdout: '', stderr: 'unexpected command' };
    },
  };
}

describe('consumer Firestore index readiness', () => {
  it('rejects redundant single-field composites before any cloud command', async () => {
    const calls: string[] = [];
    const runner = fakeLists([], [], calls);
    const invalid = Buffer.from(
      JSON.stringify({
        indexes: [
          {
            collectionGroup: 'contacts',
            queryScope: 'COLLECTION',
            fields: [
              { fieldPath: 'name', order: 'ASCENDING' },
              { fieldPath: '__name__', order: 'ASCENDING' },
            ],
          },
        ],
        fieldOverrides: [],
      }),
    );
    await expect(provisionTargetFirestoreIndexes(runner, identity, invalid)).rejects.toThrow(
      'duplicates an automatic single-field index',
    );
    expect(calls).toEqual([]);
  });

  it('provisions only missing manifest resources for the explicit named database', async () => {
    const commands: string[][] = [];
    const runner: CommandRunner = {
      async run(command, args) {
        if (args[0] === 'firestore' && args[3] === 'list')
          return { ok: true, stdout: '[]', stderr: '' };
        commands.push([command, ...args]);
        return { ok: true, stdout: '', stderr: '' };
      },
    };
    const result = await provisionTargetFirestoreIndexes(
      runner,
      { ...identity, databaseId: 'assistant-production' },
      specBytes,
    );
    expect(result.indexesCreated).toBe(spec.indexes.length);
    expect(result.exemptionsCreated).toBe(spec.fieldOverrides.length);
    expect(commands).toHaveLength(spec.indexes.length + spec.fieldOverrides.length);
    expect(commands.every((args) => args.includes('--database=assistant-production'))).toBe(true);
    expect(commands.every((args) => args.includes('--async'))).toBe(true);
    expect(commands.some((args) => args.includes('--disable-indexes'))).toBe(true);
    expect(
      commands.some((args) =>
        args.includes(
          '--field-config=field-path=embedding,vector-config={"dimension":"1536","flat":"{}"}',
        ),
      ),
    ).toBe(true);
  });

  it('is idempotent when every shared resource already exists', async () => {
    const calls: string[] = [];
    const runner = fakeLists(
      liveIndexes('assistant-production'),
      liveOverrides('assistant-production'),
      calls,
    );
    await expect(
      provisionTargetFirestoreIndexes(
        runner,
        { ...identity, databaseId: 'assistant-production' },
        specBytes,
      ),
    ).resolves.toEqual({ indexesCreated: 0, exemptionsCreated: 0 });
    expect(calls).toHaveLength(2);
  });

  it('verifies and recognizes existing vector indexes with the Google list field order', async () => {
    const actualIndexes = liveIndexes('assistant-production');
    const vectorIndexes = actualIndexes.filter((index) =>
      index.fields.some((field) => field.vectorConfig !== undefined),
    );
    expect(vectorIndexes).toHaveLength(
      spec.indexes.filter((index) => index.fields.some((field) => field.vectorConfig)).length,
    );
    expect(
      vectorIndexes.every((index) => {
        const vectorPosition = index.fields.findIndex((field) => field.vectorConfig);
        return index.fields[vectorPosition - 1]?.fieldPath === '__name__';
      }),
    ).toBe(true);

    const calls: string[] = [];
    const runner = fakeLists(actualIndexes, liveOverrides('assistant-production'), calls);
    const target = { ...identity, databaseId: 'assistant-production' };
    await expect(verifyConsumerIndexReadiness(runner, target, specBytes)).resolves.toBeUndefined();
    await expect(provisionTargetFirestoreIndexes(runner, target, specBytes)).resolves.toEqual({
      indexesCreated: 0,
      exemptionsCreated: 0,
    });
    expect(calls).toHaveLength(4);
  });

  it('declares the exact person experience scan index in the shared manifest', () => {
    expect(spec.indexes).toContainEqual({
      collectionGroup: 'memories',
      queryScope: 'COLLECTION',
      fields: [
        { fieldPath: 'agentId', order: 'ASCENDING' },
        { fieldPath: 'subjectContactId', order: 'ASCENDING' },
        { fieldPath: 'category', order: 'ASCENDING' },
      ],
    });
  });

  it('preserves explicit document-name directions for stable keyset indexes', async () => {
    const documentIndex = spec.indexes.find(
      (index) =>
        index.collectionGroup === 'documents' &&
        index.fields.some((field) => field.fieldPath === '__name__'),
    );
    const ascendingIndex = spec.indexes.find(
      (index) =>
        index.collectionGroup === 'privacyErasureAssets' &&
        index.fields.some((field) => field.fieldPath === '__name__'),
    );
    expect(documentIndex?.fields.at(-1)).toEqual({ fieldPath: '__name__', order: 'DESCENDING' });
    expect(ascendingIndex?.fields.at(-1)).toEqual({ fieldPath: '__name__', order: 'ASCENDING' });
    await expect(
      verifyConsumerIndexReadiness(
        fakeLists(liveIndexes(), liveOverrides(), []),
        identity,
        specBytes,
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects an explicit document-name direction that cannot be reproduced by the preceding field', async () => {
    const changed = JSON.parse(specBytes.toString('utf8')) as typeof spec;
    const documentIndex = changed.indexes.find(
      (index) =>
        index.collectionGroup === 'documents' &&
        index.fields.some((field) => field.fieldPath === '__name__'),
    );
    const nameField = documentIndex?.fields.find((field) => field.fieldPath === '__name__');
    if (!nameField) throw new Error('expected explicit document-name index field');
    nameField.order = 'ASCENDING';
    await expect(
      verifyConsumerIndexReadiness(
        fakeLists(liveIndexes(), liveOverrides(), []),
        identity,
        Buffer.from(JSON.stringify(changed)),
      ),
    ).rejects.toThrow('document-name order must match');
  });

  it('accepts exactly the trusted READY indexes and active field exemptions', async () => {
    const calls: string[] = [];
    await verifyConsumerIndexReadiness(
      fakeLists(liveIndexes(), liveOverrides(), calls),
      identity,
      specBytes,
    );
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.includes('--project=customer-project'))).toBe(true);
    expect(calls.every((call) => call.includes('--database=(default)'))).toBe(true);
    expect(calls.every((call) => call.includes('--format=json'))).toBe(true);
  });

  it.each([
    ['missing composite', () => liveIndexes().slice(1), liveOverrides],
    [
      'building composite',
      () => liveIndexes().map((row, i) => (i ? row : { ...row, state: 'CREATING' })),
      liveOverrides,
    ],
    [
      'extra composite',
      () => [...liveIndexes(), { ...liveIndexes()[0], name: `${prefix}extra/indexes/999` }],
      liveOverrides,
    ],
    [
      'foreign composite',
      () =>
        liveIndexes().map((row, i) =>
          i ? row : { ...row, name: row.name.replace('customer-project', 'foreign-project') },
        ),
      liveOverrides,
    ],
    [
      'changed composite fields',
      () => liveIndexes().map((row, i) => (i ? row : { ...row, fields: row.fields.slice(1) })),
      liveOverrides,
    ],
    ['missing exemption', liveIndexes, () => liveOverrides().slice(0, -1)],
    [
      'extra exemption',
      liveIndexes,
      () => [
        ...liveOverrides(),
        { name: `${prefix}extra/fields/mystery`, indexConfig: { indexes: [] } },
      ],
    ],
    [
      'foreign exemption',
      liveIndexes,
      () =>
        liveOverrides().map((row, i) =>
          i === 1 ? { ...row, name: row.name.replace('customer-project', 'foreign-project') } : row,
        ),
    ],
    [
      'reverting exemption',
      liveIndexes,
      () =>
        liveOverrides().map((row, i) =>
          i === 1 ? { ...row, indexConfig: { indexes: [], reverting: true } } : row,
        ),
    ],
    ['duplicate default field', liveIndexes, () => [liveOverrides()[0], ...liveOverrides()]],
  ])('rejects %s', async (_name, indexes, fields) => {
    await expect(
      verifyConsumerIndexReadiness(fakeLists(indexes(), fields(), []), identity, specBytes),
    ).rejects.toThrow();
  });

  it('fails closed on a malformed or failed authenticated list', async () => {
    const calls: string[] = [];
    const runner = fakeLists(liveIndexes(), liveOverrides(), calls);
    const original = runner.run.bind(runner);
    runner.run = async (command, args) =>
      args[2] === 'fields'
        ? { ok: false, stdout: '', stderr: 'permission denied' }
        : original(command, args);
    await expect(verifyConsumerIndexReadiness(runner, identity, specBytes)).rejects.toThrow(
      'permission denied',
    );
    await expect(
      verifyConsumerIndexReadiness(fakeLists({}, liveOverrides(), []), identity, specBytes),
    ).rejects.toThrow('malformed');
  });

  it('waits for a matching CREATING index and then accepts READY', async () => {
    let reads = 0;
    const delays: number[] = [];
    const runner = fakeLists(liveIndexes(), liveOverrides(), []);
    const original = runner.run.bind(runner);
    runner.run = async (command, args) => {
      if (args[2] === 'composite') {
        reads++;
        const indexes = liveIndexes().map((index, number) =>
          reads === 1 && number === 0 ? { ...index, state: 'CREATING' } : index,
        );
        return { ok: true, stdout: JSON.stringify(indexes), stderr: '' };
      }
      return original(command, args);
    };
    await waitForConsumerIndexReadiness(runner, identity, specBytes, {
      timeoutMs: 1000,
      intervalMs: 25,
      sleep: async (delay) => {
        delays.push(delay);
      },
    });
    expect(reads).toBe(2);
    expect(delays).toEqual([25]);
  });

  it('does not wait on a foreign index even when another index is CREATING', async () => {
    const indexes = liveIndexes().map((index, number) =>
      number === 0
        ? { ...index, state: 'CREATING' }
        : number === 1
          ? { ...index, name: index.name.replace('customer-project', 'foreign-project') }
          : index,
    );
    const sleep = async () => {
      throw new Error('unexpected wait');
    };
    await expect(
      waitForConsumerIndexReadiness(fakeLists(indexes, liveOverrides(), []), identity, specBytes, {
        sleep,
      }),
    ).rejects.toThrow('Foreign Firestore index');
  });
});
