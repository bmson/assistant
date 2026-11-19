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
  let matched = 0;
  let setupMatches = 0;
  let setupDeliveries = 0;
  let quietViolations = 0;
  for (const [fact, value] of Object.entries(definition.facts ?? {}))
    if (sourceEvidence[fact] !== value)
      findings.push(`source: expected ${fact} = ${String(value)}`);
  for (const [name, expected] of Object.entries(definition.ticks)) {
    const seen = ticks.filter((tick) => tick.name === name);
    if (seen.length !== 1) {
      findings.push(`${name}: expected one observation, found ${seen.length}`);
      continue;
    }
    const tick = seen[0];
    if (!tick) continue;
    if (expected.deliveries === 1 && expected.setup) setupDeliveries += observedDeliveries(tick);
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
      quietViolations += Math.max(
        tick.moments.length,
        tick.ownerNotices,
        tick.pushSinkCalls,
        tick.selected === null ? 0 : 1,
      );
      if (tick.selected !== null || tick.reason !== expected.reason)
        findings.push(`${name}: expected no selection with ${expected.reason}`);
      continue;
    }
    const [moment] = tick.moments;
    const grounded =
      tick.selected === expected.kind &&
      moment?.kind === expected.kind &&
      moment.exactSource &&
      moment.durableCard &&
      moment.groundedCard;
    if (!grounded)
      findings.push(`${name}: expected exact-source ${expected.kind} with a durable card`);
    const onTime =
      moment &&
      moment.elapsedMinutes >= expected.earliestMinutes &&
      moment.elapsedMinutes <= expected.latestMinutes;
    if (moment && !onTime) findings.push(`${name}: durable moment outside the delivery window`);
    if (grounded && onTime) {
      const credit =
        tick.pushSinkCalls === 1 && tick.pushAcknowledged && moment.durablePushAcknowledged
          ? 1
          : 0.5;
      matched += credit;
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
    sourceEvidence,
    ticks: ticks.map((tick) => ({ ...tick, expected: definition.ticks[tick.name] ?? null })),
  };
}

export type ScoredReplayCase = ReturnType<typeof scoreReplayCase>;

export function writeReplayEvidence(driver: ReplayDriver, cases: readonly ScoredReplayCase[]) {
  const directory = process.env.ASSISTANT_REPLAY_SCORE_TEMP;
  if (directory)
    writeFileSync(join(directory, `${driver}.json`), `${JSON.stringify(cases, null, 2)}\n`, {
      flag: 'wx',
    });
}
