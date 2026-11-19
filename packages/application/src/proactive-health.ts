import { isModuleEnabled, loadConfig } from '@assistant/config';
import { getAgent } from '@assistant/core/chat';
import {
  assessProactiveCanaries,
  assessProactiveHealth,
  dailyBudgetHoldHealth,
  type ProactiveCanaries,
  type ProactiveHealth,
  proactiveCanaryProblems,
} from '@assistant/core/proactive/pipeline-health';
import {
  assertPostgresInstallationOwner,
  createPostgresCostRepository,
  type Db,
} from '@assistant/db';
import type {
  CostRepository,
  ProactiveCanaryRepository,
  ProactiveHealthRepository,
} from '@assistant/persistence';

/**
 * "Is the assistant actually able to notice anything?" as a view model.
 *
 * Every proactive producer is self-silencing, which means a broken pipeline and
 * a quiet week look identical from the outside. This is the one surface that
 * tells them apart: what arrived, what was said, what reached the phone, and
 * the specific misconfigurations that would explain a zero.
 */
export interface ProactiveHealthView extends Omit<ProactiveHealth, 'lastMailAt'> {
  /** ISO string, or null — presentation never receives a Date. */
  lastMailAt: string | null;
  dailyBudgetHolds: 'within_limit' | 'above_threshold' | 'paused' | 'uncapped' | 'unavailable';
  /** Everything is arriving and reachable. */
  healthy: boolean;
}

export async function getProactiveHealth(db: Db): Promise<ProactiveHealthView> {
  const owner = (await getAgent(db)).id;
  return proactiveHealthView(db, owner, async () => {
    await assertPostgresInstallationOwner(db, owner);
    return createPostgresCostRepository(db).totals();
  });
}

export { dailyBudgetHoldHealth };

/** The same view over a portable counts repository, for the configured owner. */
export async function proactiveHealthView(
  storage: Db | ProactiveHealthRepository,
  agentId: string,
  readTotals: CostRepository['totals'],
): Promise<ProactiveHealthView> {
  const config = loadConfig();
  const [health, dailyBudgetHolds] = await Promise.all([
    assessProactiveHealth(storage, agentId, {
      ingestMode: config.EMAIL_INGEST_MODE,
      googleEnabled: isModuleEnabled(config, 'google'),
    }),
    dailyBudgetHoldHealth(readTotals),
  ]);
  const warnings = [...health.warnings];
  if (dailyBudgetHolds === 'above_threshold')
    warnings.push(
      'Pending cost estimates hold over 25% of today’s budget. See Costs for the reserved amounts.',
    );
  if (dailyBudgetHolds === 'paused')
    warnings.push('The daily spending cap is zero. Work that needs a budget may pause.');
  if (dailyBudgetHolds === 'unavailable') warnings.push('Daily budget holds could not be checked.');
  return {
    ...health,
    dailyBudgetHolds,
    warnings,
    lastMailAt: health.lastMailAt?.toISOString() ?? null,
    healthy: warnings.length === 0,
  };
}

export async function proactiveCanaryView(
  repository: ProactiveCanaryRepository,
  ownerId: string,
  now: Date,
): Promise<{ canaries: ProactiveCanaries; warnings: string[] }> {
  const canaries = await assessProactiveCanaries(
    repository,
    ownerId,
    loadConfig(),
    now,
    'observer',
  );
  return { canaries, warnings: proactiveCanaryProblems(canaries).map(({ detail }) => detail) };
}
