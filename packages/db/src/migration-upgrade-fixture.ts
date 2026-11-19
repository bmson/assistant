export type FixturePrimaryOutcome = { thrown: false } | { thrown: true; error: unknown };

type CleanupStage =
  | 'client'
  | 'database_drop'
  | 'database_absence'
  | 'admin'
  | 'temporary_directory';

export interface MigrationFixtureCleanupReport {
  client: 'closed' | 'not_open' | 'unknown';
  database: 'absent' | 'unknown';
  admin: 'closed' | 'unknown';
  temporaryDirectory: 'removed' | 'not_allocated' | 'retained' | 'unknown';
}

export class MigrationFixtureCleanupError extends AggregateError {
  constructor(
    primary: FixturePrimaryOutcome,
    failures: { stage: CleanupStage; error: unknown }[],
    readonly cleanupReport: Readonly<MigrationFixtureCleanupReport>,
  ) {
    super(
      [...(primary.thrown ? [primary.error] : []), ...failures.map(({ error }) => error)],
      'Migration upgrade fixture cleanup was not confirmed',
      primary.thrown ? { cause: primary.error } : undefined,
    );
    this.cleanupStages = failures.map(({ stage }) => stage);
  }

  readonly cleanupStages: readonly CleanupStage[];
}

/** Test-only coordination; callbacks retain all existing resource ownership checks. */
export async function finishMigrationUpgradeFixture(input: {
  primary: FixturePrimaryOutcome;
  created: boolean;
  closeClient?: () => Promise<unknown>;
  dropOwnedDatabase: () => Promise<unknown>;
  databaseIsAbsent: () => Promise<boolean>;
  closeAdmin: () => Promise<unknown>;
  removePrefixDirectory?: () => Promise<unknown>;
}): Promise<MigrationFixtureCleanupReport> {
  const failures: { stage: CleanupStage; error: unknown }[] = [];
  const report: MigrationFixtureCleanupReport = {
    client: input.closeClient ? 'unknown' : 'not_open',
    database: 'unknown',
    admin: 'unknown',
    temporaryDirectory: input.removePrefixDirectory ? 'retained' : 'not_allocated',
  };
  const attempt = async (stage: CleanupStage, action: () => Promise<unknown>) => {
    try {
      await action();
      return true;
    } catch (error) {
      failures.push({ stage, error });
      return false;
    }
  };

  if (input.closeClient && (await attempt('client', input.closeClient))) report.client = 'closed';
  if (input.created) {
    if (await attempt('database_drop', input.dropOwnedDatabase)) {
      await attempt('database_absence', async () => {
        if (!(await input.databaseIsAbsent()))
          throw new Error('Owned fixture database absence was not confirmed');
        report.database = 'absent';
      });
    }
  } else {
    // A failed CREATE can have an unknown outcome. Never infer absence or drop
    // a target whose creation/ownership was not established by this fixture.
    failures.push({
      stage: 'database_absence',
      error: new Error('Fixture database allocation outcome is unknown'),
    });
  }
  if (await attempt('admin', input.closeAdmin)) report.admin = 'closed';

  if (
    input.removePrefixDirectory &&
    report.client !== 'unknown' &&
    report.database === 'absent' &&
    report.admin === 'closed'
  ) {
    report.temporaryDirectory = (await attempt('temporary_directory', input.removePrefixDirectory))
      ? 'removed'
      : 'unknown';
  }
  if (failures.length) throw new MigrationFixtureCleanupError(input.primary, failures, report);
  if (input.primary.thrown) throw input.primary.error;
  return report;
}
