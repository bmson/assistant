import { expect, it } from 'vitest';
import {
  type FixturePrimaryOutcome,
  finishMigrationUpgradeFixture,
  MigrationFixtureCleanupError,
} from './migration-upgrade-fixture.js';

type Stage = 'client' | 'database_drop' | 'database_absence' | 'admin' | 'temporary_directory';
const stages: Stage[] = [
  'client',
  'database_drop',
  'database_absence',
  'admin',
  'temporary_directory',
];

function fixture(
  options: {
    fail?: Stage[];
    primary?: FixturePrimaryOutcome;
    created?: boolean;
    absent?: boolean;
    client?: boolean;
    directory?: boolean;
  } = {},
) {
  const calls: Stage[] = [];
  const errors = new Map(stages.map((stage) => [stage, new Error(`synthetic ${stage}`)]));
  const action = async (stage: Stage) => {
    calls.push(stage);
    if (options.fail?.includes(stage)) throw errors.get(stage);
  };
  const input = {
    primary: options.primary ?? { thrown: false as const },
    created: options.created ?? true,
    closeClient: options.client === false ? undefined : () => action('client'),
    dropOwnedDatabase: () => action('database_drop'),
    databaseIsAbsent: async () => {
      await action('database_absence');
      return options.absent ?? true;
    },
    closeAdmin: () => action('admin'),
    removePrefixDirectory:
      options.directory === false ? undefined : () => action('temporary_directory'),
  };
  return { input, calls, errors };
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  const result = await promise.then(
    () => ({ rejected: false, error: undefined }),
    (error: unknown) => ({ rejected: true, error }),
  );
  expect(result.rejected).toBe(true);
  return result.error;
}

it('attempts exact callbacks in order and removes evidence only after confirmed closure', async () => {
  const f = fixture();
  expect(await finishMigrationUpgradeFixture(f.input)).toEqual({
    client: 'closed',
    database: 'absent',
    admin: 'closed',
    temporaryDirectory: 'removed',
  });
  expect(f.calls).toEqual(stages);
});

it.each(stages)(
  'surfaces %s failure without short-circuiting administrator closure',
  async (stage) => {
    const f = fixture({ fail: [stage] });
    const error = await rejected(finishMigrationUpgradeFixture(f.input));
    expect(error).toBeInstanceOf(MigrationFixtureCleanupError);
    if (!(error instanceof MigrationFixtureCleanupError)) throw new Error('Expected cleanup error');
    expect(error.errors).toEqual([f.errors.get(stage)]);
    expect(error.cleanupStages).toEqual([stage]);
    expect(f.calls).toContain('admin');
    if (stage !== 'temporary_directory') {
      expect(f.calls).not.toContain('temporary_directory');
      expect(error.cleanupReport.temporaryDirectory).toBe('retained');
    } else expect(error.cleanupReport.temporaryDirectory).toBe('unknown');
    if (stage === 'client') expect(f.calls).toContain('database_drop');
    if (stage === 'database_drop') expect(f.calls).not.toContain('database_absence');
  },
);

it('requires absence readback even after a successful DROP callback', async () => {
  const f = fixture({ absent: false });
  const error = await rejected(finishMigrationUpgradeFixture(f.input));
  expect(error).toBeInstanceOf(MigrationFixtureCleanupError);
  if (!(error instanceof MigrationFixtureCleanupError)) throw new Error('Expected cleanup error');
  expect(error.cleanupStages).toEqual(['database_absence']);
  expect(error.cleanupReport.database).toBe('unknown');
  expect(error.cleanupReport.temporaryDirectory).toBe('retained');
  expect(f.calls).toEqual(['client', 'database_drop', 'database_absence', 'admin']);
});

it('never drops or infers absence after an unconfirmed allocation', async () => {
  const f = fixture({ created: false });
  const error = await rejected(finishMigrationUpgradeFixture(f.input));
  expect(error).toBeInstanceOf(MigrationFixtureCleanupError);
  if (!(error instanceof MigrationFixtureCleanupError)) throw new Error('Expected cleanup error');
  expect(f.calls).toEqual(['client', 'admin']);
  expect(error.cleanupStages).toEqual(['database_absence']);
  expect(error.cleanupReport).toEqual({
    client: 'closed',
    database: 'unknown',
    admin: 'closed',
    temporaryDirectory: 'retained',
  });
});

it('handles absent client and temporary-directory allocations without extra callbacks', async () => {
  const f = fixture({ client: false, directory: false });
  expect(await finishMigrationUpgradeFixture(f.input)).toEqual({
    client: 'not_open',
    database: 'absent',
    admin: 'closed',
    temporaryDirectory: 'not_allocated',
  });
  expect(f.calls).toEqual(['database_drop', 'database_absence', 'admin']);
});

const primaryValues = [undefined, null, 0, false, new Error('synthetic body failure')];
it.each(primaryValues.map((error, index) => ({ error, index })))(
  'preserves original body-only thrown value $index',
  async ({ error }) => {
    const f = fixture({ primary: { thrown: true, error } });
    expect(await rejected(finishMigrationUpgradeFixture(f.input))).toBe(error);
    expect(f.calls).toEqual(stages);
  },
);

it.each(primaryValues.map((error, index) => ({ error, index })))(
  'preserves body value $index first and as cause alongside ordered cleanup failures',
  async ({ error: primary }) => {
    const f = fixture({
      primary: { thrown: true, error: primary },
      fail: ['client', 'database_drop', 'admin'],
    });
    const error = await rejected(finishMigrationUpgradeFixture(f.input));
    expect(error).toBeInstanceOf(MigrationFixtureCleanupError);
    if (!(error instanceof MigrationFixtureCleanupError)) throw new Error('Expected cleanup error');
    expect(error.errors).toEqual([
      primary,
      f.errors.get('client'),
      f.errors.get('database_drop'),
      f.errors.get('admin'),
    ]);
    expect(Object.hasOwn(error, 'cause')).toBe(true);
    expect(error.cause).toBe(primary);
    expect(error.cleanupStages).toEqual(['client', 'database_drop', 'admin']);
    expect(error.cleanupReport.temporaryDirectory).toBe('retained');
  },
);

it.each(Array.from({ length: 32 }, (_, mask) => ({ mask })))(
  'collects the reachable cleanup failures for combination $mask',
  async ({ mask }) => {
    const fail = stages.filter((_, index) => (mask & (1 << index)) !== 0);
    const f = fixture({ fail });
    const expectedCalls: Stage[] = ['client', 'database_drop'];
    if (!fail.includes('database_drop')) expectedCalls.push('database_absence');
    expectedCalls.push('admin');
    if (!fail.some((stage) => stage !== 'temporary_directory'))
      expectedCalls.push('temporary_directory');
    const expectedFailures = expectedCalls.filter((stage) => fail.includes(stage));
    if (expectedFailures.length) {
      const error = await rejected(finishMigrationUpgradeFixture(f.input));
      expect(error).toBeInstanceOf(MigrationFixtureCleanupError);
      if (!(error instanceof MigrationFixtureCleanupError))
        throw new Error('Expected cleanup error');
      expect(error.cleanupStages).toEqual(expectedFailures);
      expect(error.errors).toEqual(expectedFailures.map((stage) => f.errors.get(stage)));
    } else await finishMigrationUpgradeFixture(f.input);
    expect(f.calls).toEqual(expectedCalls);
  },
);

it('does not retry an ownership refusal or touch a sibling fixture', async () => {
  const owners = new Map([
    ['first', 'different-owner'],
    ['sibling', 'sibling-token'],
  ]);
  const f = fixture();
  const refused = new Error('Synthetic ownership mismatch');
  let drops = 0;
  f.input.dropOwnedDatabase = async () => {
    drops++;
    if (owners.get('first') !== 'first-token') throw refused;
    owners.delete('first');
  };
  const error = await rejected(finishMigrationUpgradeFixture(f.input));
  expect(error).toBeInstanceOf(MigrationFixtureCleanupError);
  if (!(error instanceof MigrationFixtureCleanupError)) throw new Error('Expected cleanup error');
  expect(error.errors).toEqual([refused]);
  expect(drops).toBe(1);
  expect(owners.get('first')).toBe('different-owner');
  expect(owners.get('sibling')).toBe('sibling-token');
  expect(f.calls).toEqual(['client', 'admin']);
});

it('attempts both owned closures independently and retains only the uncertain fixture evidence', async () => {
  const remaining = new Set(['first', 'sibling']);
  const first = fixture({ fail: ['client'] });
  const sibling = fixture();
  let firstAdminClosed = false;
  let siblingAdminClosed = false;
  let firstDirectoryRemoved = false;
  let siblingDirectoryRemoved = false;
  first.input.dropOwnedDatabase = async () => {
    remaining.delete('first');
  };
  first.input.databaseIsAbsent = async () => !remaining.has('first');
  first.input.closeAdmin = async () => {
    firstAdminClosed = true;
  };
  first.input.removePrefixDirectory = async () => {
    firstDirectoryRemoved = true;
  };
  sibling.input.dropOwnedDatabase = async () => {
    remaining.delete('sibling');
  };
  sibling.input.databaseIsAbsent = async () => !remaining.has('sibling');
  sibling.input.closeAdmin = async () => {
    siblingAdminClosed = true;
  };
  sibling.input.removePrefixDirectory = async () => {
    siblingDirectoryRemoved = true;
  };
  await rejected(finishMigrationUpgradeFixture(first.input));
  expect(firstAdminClosed).toBe(true);
  expect(firstDirectoryRemoved).toBe(false);
  expect(remaining.has('sibling')).toBe(true);
  expect(siblingAdminClosed).toBe(false);
  expect(siblingDirectoryRemoved).toBe(false);
  expect(await finishMigrationUpgradeFixture(sibling.input)).toEqual({
    client: 'closed',
    database: 'absent',
    admin: 'closed',
    temporaryDirectory: 'removed',
  });
  expect(siblingAdminClosed).toBe(true);
  expect(siblingDirectoryRemoved).toBe(true);
  expect(remaining.size).toBe(0);
});
