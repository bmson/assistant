import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type ReplayDriver = 'postgres' | 'firestore';
type Timing = { earliestMinutes: number; latestMinutes: number };
type Suppression = { deliveries: 0; phase: 'pending' | 'suppressed'; reason: string };

export interface ReplayTick {
  name: string;
  elapsedMinutes: number;
  candidates: number | null;
  selected: string | null;
  reason: string | null;
  moments: Array<{
    kind: string;
    exactSource: boolean;
    elapsedMinutes: number;
    durableCard: boolean;
    durablePushAcknowledged: boolean;
    groundedCard: boolean;
  }>;
  ownerNotices: number;
  pushSinkCalls: number;
  pushAcknowledged: boolean;
}

type ReplayEvidence = Record<string, string | number | boolean | null>;

export interface ReplayCase {
  id: string;
  facts?: ReplayEvidence;
  ticks: Record<string, Suppression | ({ deliveries: 1; kind: string; setup?: true } & Timing)>;
}

// The three observations overlap for a normal delivery. Excess ledger entries,
// messages or push calls are distinct over-delivery on the observed surface.
function observedDeliveries(tick: ReplayTick): number {
  return Math.max(tick.moments.length, tick.ownerNotices, tick.pushSinkCalls);
}

export function scoreReplayCase(
  definition: ReplayCase,
  ticks: readonly ReplayTick[],
  sourceEvidence: ReplayEvidence,
) {
  const findings: string[] = [];
  const deliveryChecks: Array<Timing & { tick: string; kind: string; credit: number }> = [];
  const quietChecks: Array<
    Suppression & { tick: string; observations: number; violations: number }
  > = [];
  let matched = 0;
  let setupMatches = 0;
  let setupDeliveries = 0;
  let quietViolations = 0;
  for (const [fact, value] of Object.entries(definition.facts ?? {}))
    if (sourceEvidence[fact] !== value)
      findings.push(`source: expected ${fact} = ${String(value)}`);
  for (const [name, expected] of Object.entries(definition.ticks)) {
    const seen = ticks.filter((tick) => tick.name === name);
    if (expected.deliveries === 1 && expected.setup)
      setupDeliveries += seen.reduce((sum, tick) => sum + observedDeliveries(tick), 0);
    const deliveryCheck =
      expected.deliveries === 1 && !expected.setup
        ? {
            tick: name,
            kind: expected.kind,
            earliestMinutes: expected.earliestMinutes,
            latestMinutes: expected.latestMinutes,
            credit: 0,
          }
        : null;
    if (deliveryCheck) deliveryChecks.push(deliveryCheck);
    if (expected.deliveries === 0) {
      const violations = seen.reduce(
        (sum, tick) => sum + Math.max(observedDeliveries(tick), tick.selected === null ? 0 : 1),
        0,
      );
      quietViolations += violations;
      quietChecks.push({ ...expected, tick: name, observations: seen.length, violations });
    }
    if (seen.length !== 1) {
      findings.push(`${name}: expected one observation, found ${seen.length}`);
      continue;
    }
    const tick = seen[0];
    if (!tick) continue;
    if (
      tick.moments.length !== expected.deliveries ||
      tick.ownerNotices !== expected.deliveries ||
      tick.pushSinkCalls !== expected.deliveries ||
      tick.pushAcknowledged !== (expected.deliveries === 1) ||
      tick.moments.some((moment) => moment.durablePushAcknowledged !== tick.pushAcknowledged)
    ) {
      findings.push(`${name}: logical delivery, sink call, or sink acknowledgment count differs`);
    }
    if (expected.deliveries === 0) {
      if (tick.selected !== null || tick.reason !== expected.reason)
        findings.push(`${name}: expected no selection with ${expected.reason}`);
      continue;
    }
    const grounded = tick.moments.filter(
      (moment) =>
        tick.selected === expected.kind &&
        moment.kind === expected.kind &&
        moment.exactSource &&
        moment.durableCard &&
        moment.groundedCard,
    );
    if (grounded.length === 0)
      findings.push(`${name}: expected exact-source ${expected.kind} with a durable card`);
    const onTime = (moment: ReplayTick['moments'][number]) =>
      moment.elapsedMinutes >= expected.earliestMinutes &&
      moment.elapsedMinutes <= expected.latestMinutes;
    if (tick.moments.some((moment) => !onTime(moment)))
      findings.push(`${name}: durable moment outside the delivery window`);
    const matches = grounded.filter(onTime);
    if (matches.length > 0) {
      const confirmedPush =
        tick.pushSinkCalls === 1 &&
        tick.pushAcknowledged &&
        matches.some((moment) => moment.durablePushAcknowledged);
      const credit = confirmedPush ? 1 : 0.5;
      matched += credit;
      if (deliveryCheck) deliveryCheck.credit = credit;
      if (expected.setup) {
        setupMatches += credit;
      }
    }
  }
  for (const tick of ticks)
    if (!Object.hasOwn(definition.ticks, tick.name)) findings.push(`${tick.name}: unexpected tick`);
  return {
    id: definition.id,
    passed: findings.length === 0,
    findings,
    expected: Object.values(definition.ticks).filter((tick) => tick.deliveries === 1).length,
    delivered: ticks.reduce((sum, tick) => sum + observedDeliveries(tick), 0),
    matched,
    setupExpected: Object.values(definition.ticks).filter(
      (tick) => tick.deliveries === 1 && tick.setup,
    ).length,
    setupDeliveries,
    setupMatches,
    quietViolations,
    quietChecks,
    deliveryChecks,
    sourceEvidence,
    ticks: ticks.map((tick) => ({ ...tick, expected: definition.ticks[tick.name] ?? null })),
  };
}

export type ScoredReplayCase = ReturnType<typeof scoreReplayCase>;

type KindEvidence = {
  kind: string | null;
  delivered: number;
  expectations: Array<ScoredReplayCase['deliveryChecks'][number] & { caseId: string }>;
  observedTiming: Array<{ caseId: string; tick: string; elapsedMinutes: number }>;
};

// The caller supplies the observed benchmark cases, excluding the generic control.
export function scoreReplayKinds(cases: readonly ScoredReplayCase[]) {
  const kinds = new Map<string | null, KindEvidence>();
  const forKind = (kind: string | null) => {
    let row = kinds.get(kind);
    if (!row) {
      row = { kind, delivered: 0, expectations: [], observedTiming: [] };
      kinds.set(kind, row);
    }
    return row;
  };
  for (const row of cases) {
    for (const check of row.deliveryChecks)
      forKind(check.kind).expectations.push({ ...check, caseId: row.id });
    for (const tick of row.ticks) {
      if (tick.expected?.deliveries === 1 && tick.expected.setup) continue;
      for (const moment of tick.moments) {
        const kind = forKind(moment.kind);
        kind.delivered++;
        kind.observedTiming.push({
          caseId: row.id,
          tick: tick.name,
          elapsedMinutes: moment.elapsedMinutes,
        });
      }
      const excess = observedDeliveries(tick) - tick.moments.length;
      if (excess > 0) forKind(null).delivered += excess;
    }
  }
  return [...kinds.values()]
    .sort((a, b) => (a.kind ?? '').localeCompare(b.kind ?? ''))
    .map((row) => {
      const expected = row.expectations.length;
      const matched = row.expectations.reduce((sum, check) => sum + check.credit, 0);
      const misses = row.expectations.filter((check) => check.credit === 0).length;
      return {
        ...row,
        expected,
        matched,
        misses,
        falsePositives: row.delivered - (expected - misses),
        recall: expected ? matched / expected : null,
        precision: row.delivered ? matched / row.delivered : null,
      };
    });
}

export function writeReplayEvidence(driver: ReplayDriver, cases: readonly ScoredReplayCase[]) {
  const directory = process.env.ASSISTANT_REPLAY_SCORE_TEMP;
  if (directory)
    writeFileSync(join(directory, `${driver}.json`), `${JSON.stringify(cases, null, 2)}\n`, {
      flag: 'wx',
    });
}
