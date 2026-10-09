import { createHash, randomUUID } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { link, lstat, mkdir, open, readdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ExecutorDeps } from '@assistant/core';
import type { ScheduleRecord, ScheduleRepository } from '@assistant/persistence';
import type { RegisteredTool } from '@assistant/tools';

const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pendingEvidenceName(runId: string, sequence: number) {
  return `.pending-${runId}-${String(sequence).padStart(6, '0')}-${randomUUID()}.tmp`;
}

function pendingEvidenceSequence(name: string, runId: string) {
  const match = new RegExp(
    `^\\.pending-${runId}-([0-9]{6})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tmp$`,
    'i',
  ).exec(name);
  return match?.[1] ? Number(match[1]) : null;
}

/** Parse a deliberate rehearsal allowlist and reject every effectful capability. */
export function goalSessionToolAllowlist(
  raw: string | undefined,
  registered: readonly RegisteredTool[],
): ReadonlySet<string> {
  if (!raw?.trim()) throw new Error('Set ASSISTANT_GOAL_SESSION_TOOL_ALLOWLIST explicitly');
  const names = raw.split(',').map((name) => name.trim());
  if (names.some((name) => !name) || new Set(names).size !== names.length)
    throw new Error('Goal-session tool allowlist contains an empty or duplicate name');
  const byName = new Map(registered.map((entry) => [entry.tool.name, entry]));
  for (const name of names) {
    const entry = byName.get(name);
    if (!entry) throw new Error(`Goal-session allowlist names an unavailable tool: ${name}`);
    const { flags, tool } = entry;
    if (
      typeof tool.risk !== 'string' ||
      tool.risk !== 'autonomous' ||
      flags.internalEventKind ||
      flags.outwardFacing ||
      flags.writesMemory ||
      flags.confidentialRead ||
      flags.writesWorkspace ||
      flags.privateWrite
    )
      throw new Error(`Goal-session allowlist contains a non-read-only tool: ${name}`);
  }
  return new Set(names);
}

export function goalSessionMode(args: readonly string[], allowMetered: string | undefined) {
  const modes = args.filter(
    (arg): arg is '--plan' | '--metered-live' | '--reconcile-orphans' =>
      arg === '--plan' || arg === '--metered-live' || arg === '--reconcile-orphans',
  );
  if (modes.length !== 1 || args.some((arg) => arg.startsWith('--') && arg !== modes[0]))
    throw new Error('Choose exactly one of --plan, --metered-live, or --reconcile-orphans');
  if (modes[0] === '--metered-live' && allowMetered !== '1')
    throw new Error('Metered rehearsal requires ASSISTANT_ALLOW_METERED_GOAL_SESSION=1');
  if (modes[0] === '--plan') return 'plan';
  if (modes[0] === '--reconcile-orphans') return 'reconcile-orphans';
  return 'metered-live';
}

/** Model-visible definitions and dispatch are both fenced by the rehearsal allowlist. */
export function allowlistedGoalSessionDispatcher(
  dispatcher: ExecutorDeps['dispatcher'],
  allowlist: ReadonlySet<string>,
): ExecutorDeps['dispatcher'] {
  return {
    toolDefs: (trust, scope) =>
      dispatcher.toolDefs(trust, scope).filter((tool) => allowlist.has(tool.name)),
    resultIsUntrusted: (name) => dispatcher.resultIsUntrusted(name),
    dispatch: (input) =>
      allowlist.has(input.toolName)
        ? dispatcher.dispatch(input)
        : Promise.resolve({
            kind: 'rejected' as const,
            reason: 'blocked by goal-session rehearsal allowlist',
          }),
    executeApproved: async () => ({
      kind: 'failed' as const,
      error: 'approved actions are disabled in goal-session rehearsals',
    }),
  };
}

/** Only the selected schedule can be observed or committed by this repository view. */
export function scopedGoalScheduleRepository(
  repository: ScheduleRepository,
  scope: { agentId: string; scheduleId: string },
  loadDue: (now: Date) => Promise<ScheduleRecord | null>,
): ScheduleRepository {
  return {
    ...repository,
    listUninitialized: async () => [],
    listDue: async (now) => {
      const row = await loadDue(now);
      if (
        !row ||
        row.id !== scope.scheduleId ||
        row.agentId !== scope.agentId ||
        !row.enabled ||
        !row.nextRunAt ||
        row.nextRunAt > now
      )
        return [];
      return [row];
    },
  };
}

export type GoalSessionEvidencePendingWriter = (
  handle: FileHandle,
  contents: string,
) => Promise<void>;

/** Append-only private event files preserve fixture IDs and metering if cleanup is interrupted. */
export class GoalSessionEvidence {
  private sequence = 0;
  private previousDigest = '0'.repeat(64);
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    readonly directory: string,
    private readonly runId: string,
    private readonly now: () => Date = () => new Date(),
    private readonly pendingWriter: GoalSessionEvidencePendingWriter = (handle, contents) =>
      handle.writeFile(contents, 'utf8'),
  ) {}

  static async create(
    parent: string,
    runId: string,
    now?: () => Date,
    pendingWriter?: GoalSessionEvidencePendingWriter,
  ) {
    if (!path.isAbsolute(parent) || !CANONICAL_UUID_RE.test(runId))
      throw new Error('Invalid goal-session evidence location');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const directory = path.join(parent, `goal-session-${runId}`);
    await mkdir(directory, { mode: 0o700 });
    return new GoalSessionEvidence(directory, runId, now, pendingWriter);
  }

  static async open(
    directory: string,
    runId: string,
    now?: () => Date,
    pendingWriter?: GoalSessionEvidencePendingWriter,
  ) {
    if (!CANONICAL_UUID_RE.test(runId)) throw new Error('Invalid goal-session run identity');
    const events = await readGoalSessionEvidence(directory, runId);
    if (!events) throw new Error('Goal-session evidence is malformed or incomplete');
    const evidence = new GoalSessionEvidence(directory, runId, now, pendingWriter);
    evidence.sequence = events.length;
    evidence.previousDigest = events.at(-1)?.digest ?? '0'.repeat(64);
    return evidence;
  }

  async record(event: Record<string, unknown>) {
    const operation = this.writeQueue.then(() => this.writeRecord(event));
    this.writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async writeRecord(event: Record<string, unknown>) {
    const sequence = this.sequence + 1;
    const file = path.join(this.directory, `${String(sequence).padStart(6, '0')}.json`);
    const pending = path.join(this.directory, pendingEvidenceName(this.runId, sequence));
    const payload = {
      ...event,
      rehearsal: true,
      recordedAt: this.now().toISOString(),
      sequence,
      previousDigest: this.previousDigest,
    };
    const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const handle = await open(pending, 'wx', 0o600);
    try {
      await this.pendingWriter(handle, `${JSON.stringify({ ...payload, digest }, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      // link() publishes the fully synced record atomically and refuses to overwrite.
      await link(pending, file);
      this.sequence = sequence;
      this.previousDigest = digest;
    } catch (publishError) {
      try {
        await unlink(pending);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT')
          throw new AggregateError(
            [publishError, cleanupError],
            'Evidence publish and pending cleanup failed',
          );
      }
      throw publishError;
    }
    const durabilityErrors: Error[] = [];
    try {
      await unlink(pending);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        durabilityErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
    try {
      const directoryHandle = await open(this.directory, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      durabilityErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
    if (durabilityErrors.length)
      throw new AggregateError(
        durabilityErrors,
        'Evidence record was published but directory durability failed',
      );
    return file;
  }

  /** Only call after the caller owns the matching database run lock. */
  static async removeOwnedPending(directory: string, runId: string) {
    if (path.basename(directory) !== `goal-session-${runId}`)
      throw new Error('Goal-session pending evidence directory does not match run ownership');
    for (const name of await readdir(directory)) {
      if (pendingEvidenceSequence(name, runId) === null) continue;
      const file = path.join(directory, name);
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
        throw new Error('Goal-session pending evidence is not a private regular file');
      await unlink(file);
    }
  }
}

export type GoalSessionTerminalState = 'none' | 'valid' | 'invalid';

/** Only a fully validated plan or explicit no-effects record can bypass target recovery. */
export function goalSessionTerminalState(
  events: readonly GoalSessionEvidenceEvent[],
): GoalSessionTerminalState {
  const terminalIndexes = events.flatMap((entry, index) =>
    ['rehearsal_plan_complete', 'rehearsal_no_effects_complete'].includes(String(entry.event))
      ? [index]
      : [],
  );
  if (terminalIndexes.length === 0) return 'none';

  for (const index of terminalIndexes) {
    // A terminal is authoritative only at the end of the durable chain. An
    // appended intent or effect must invalidate the earlier no-effects claim.
    if (index !== events.length - 1) return 'invalid';
    const terminal = events[index];
    if (!terminal) return 'invalid';
    const prior = events.slice(0, index);
    const hasFixtureEffects = prior.some((entry) =>
      [
        'goal_fixture_planned',
        'conversation_fixture_planned',
        'goal_fixture_created',
        'conversation_fixture_created',
        'task_fixture_created',
        'schedule_fixture_created',
        'fixture_cleanup_started',
        'fixture_cleanup_failed',
      ].includes(String(entry.event)),
    );
    if (
      hasFixtureEffects ||
      terminal.effectsStarted !== false ||
      terminal.runId !== events[0]?.runId
    )
      return 'invalid';

    if (terminal.event === 'rehearsal_plan_complete') {
      const plans = prior.filter((entry) => entry.event === 'rehearsal_plan');
      const validations = prior.filter((entry) => entry.event === 'rehearsal_plan_validated');
      const plan = plans[0];
      const validated = validations[0];
      if (
        plans.length !== 1 ||
        validations.length !== 1 ||
        !plan ||
        !validated ||
        plan.runId !== terminal.runId ||
        validated.runId !== terminal.runId ||
        terminal.validated !== true ||
        validated.databaseTargetValidated !== true ||
        validated.meteredCallsWillRun !== false ||
        validated.fixturesWouldBeScoped !== true ||
        !Array.isArray(validated.namedToolAllowlist) ||
        !validated.namedToolAllowlist.every(
          (name) => typeof name === 'string' && name.length > 0,
        ) ||
        new Set(validated.namedToolAllowlist).size !== validated.namedToolAllowlist.length ||
        typeof plan.databaseName !== 'string' ||
        plan.databaseName.length === 0 ||
        typeof plan.targetToken !== 'string' ||
        plan.targetToken.length === 0
      )
        return 'invalid';
      continue;
    }

    const targetAuthority = prior.find((entry) =>
      ['rehearsal_started', 'rehearsal_target', 'rehearsal_plan'].includes(String(entry.event)),
    );
    const plans = prior.filter((entry) => entry.event === 'rehearsal_plan');
    const validations = prior.filter((entry) => entry.event === 'rehearsal_plan_validated');
    const partialPlanIsSafe =
      plans.length === 0 ||
      (plans.length === 1 &&
        validations.length === 1 &&
        plans[0]?.runId === terminal.runId &&
        validations[0]?.runId === terminal.runId &&
        validations[0]?.databaseTargetValidated === true &&
        validations[0]?.meteredCallsWillRun === false &&
        validations[0]?.fixturesWouldBeScoped === true);
    if (
      !targetAuthority ||
      targetAuthority.runId !== terminal.runId ||
      typeof targetAuthority.databaseName !== 'string' ||
      targetAuthority.databaseName.length === 0 ||
      typeof targetAuthority.targetToken !== 'string' ||
      targetAuthority.targetToken.length === 0 ||
      !partialPlanIsSafe
    )
      return 'invalid';
  }
  return 'valid';
}

/** Detect deletion, reordering, and editing of rehearsal ledger records. */
export async function verifyGoalSessionEvidence(directory: string): Promise<boolean> {
  const basename = path.basename(directory);
  const match =
    /^goal-session-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(basename);
  if (!match?.[1]) return false;
  const events = await readGoalSessionEvidence(directory, match[1]);
  return events !== null && events.length > 0;
}

export interface GoalSessionEvidenceEvent extends Record<string, unknown> {
  event: string;
  runId: string;
  digest: string;
}

/** An empty, private run directory can only precede the first fixture intent. */
export async function isEmptyPrivateGoalSessionDirectory(directory: string, runId: string) {
  if (path.basename(directory) !== `goal-session-${runId}`) return false;
  try {
    const info = await lstat(directory);
    return (
      info.isDirectory() &&
      !info.isSymbolicLink() &&
      (info.mode & 0o077) === 0 &&
      (await readdir(directory)).length === 0
    );
  } catch {
    return false;
  }
}

/** Read a complete, single-run hash chain before any recovery action. */
export async function readGoalSessionEvidence(
  directory: string,
  expectedRunId: string,
): Promise<GoalSessionEvidenceEvent[] | null> {
  try {
    const directoryInfo = await lstat(directory);
    if (
      !directoryInfo.isDirectory() ||
      directoryInfo.isSymbolicLink() ||
      (directoryInfo.mode & 0o077) !== 0
    )
      return null;
  } catch {
    return null;
  }
  const names = await readdir(directory);
  const files = names.filter((name) => /^\d{6}\.json$/.test(name)).sort();
  const pending = names.filter((name) => name.startsWith('.pending-'));
  if (names.some((name) => !files.includes(name) && !pending.includes(name))) return null;
  for (const name of pending) {
    const pendingSequence = pendingEvidenceSequence(name, expectedRunId);
    if (
      pendingSequence === null ||
      !Number.isInteger(pendingSequence) ||
      pendingSequence < 1 ||
      pendingSequence > files.length + 1
    )
      return null;
    try {
      const info = await lstat(path.join(directory, name));
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) return null;
    } catch {
      return null;
    }
  }
  let previousDigest = '0'.repeat(64);
  const events: GoalSessionEvidenceEvent[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const name = files[index];
    if (name !== `${String(index + 1).padStart(6, '0')}.json`) return null;
    try {
      const fileInfo = await lstat(path.join(directory, name));
      if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || (fileInfo.mode & 0o077) !== 0)
        return null;
    } catch {
      return null;
    }
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(await readFile(path.join(directory, name), 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      return null;
    }
    const { digest, ...payload } = entry;
    if (
      entry.sequence !== index + 1 ||
      entry.runId !== expectedRunId ||
      entry.previousDigest !== previousDigest ||
      entry.rehearsal !== true ||
      typeof digest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(digest) ||
      createHash('sha256').update(JSON.stringify(payload)).digest('hex') !== digest
    )
      return null;
    previousDigest = digest;
    events.push(entry as GoalSessionEvidenceEvent);
  }
  return files.length > 0 || pending.length > 0 ? events : null;
}
