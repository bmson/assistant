type SeedDefinition = { cron: string; taskTemplate: unknown };

export type ScheduleSeedDecision =
  | {
      kind: 'insert';
      seedTemplateKey: string;
      seedTemplateRevision: number;
      seedDefinition: SeedDefinition;
    }
  | {
      kind: 'update';
      seedTemplateKey: string;
      seedTemplateRevision: number;
      seedDefinition: SeedDefinition;
    }
  | {
      kind: 'adopt';
      seedTemplateKey: string;
      seedTemplateRevision: number;
      seedDefinition: SeedDefinition;
    }
  | { kind: 'review' }
  | { kind: 'keep' };

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}

/**
 * Reconcile only rows whose current behavior still matches a known prior seed.
 * A display name alone never grants permission to replace owner-edited values.
 */
export function decideScheduleSeed(
  current: {
    cron: string;
    taskTemplate: unknown;
    seedTemplateKey: string | null;
    seedTemplateRevision: number | null;
    seedDefinition: unknown | null;
    seedReviewRequired: boolean;
  } | null,
  desired: { key: string; revision: number; definition: SeedDefinition },
): ScheduleSeedDecision {
  if (!current)
    return {
      kind: 'insert',
      seedTemplateKey: desired.key,
      seedTemplateRevision: desired.revision,
      seedDefinition: desired.definition,
    };
  const exactDesired =
    current.cron === desired.definition.cron &&
    stable(current.taskTemplate) === stable(desired.definition.taskTemplate);
  if (
    !current.seedTemplateKey &&
    current.seedTemplateRevision === null &&
    current.seedDefinition === null &&
    !current.seedReviewRequired &&
    exactDesired
  )
    return {
      kind: 'adopt',
      seedTemplateKey: desired.key,
      seedTemplateRevision: desired.revision,
      seedDefinition: desired.definition,
    };
  const prior = current.seedDefinition as SeedDefinition | null;
  const knownSeed =
    current.seedTemplateKey === desired.key &&
    Number.isInteger(current.seedTemplateRevision) &&
    Boolean(prior) &&
    typeof prior?.cron === 'string' &&
    stable({ cron: current.cron, taskTemplate: current.taskTemplate }) === stable(prior);
  if (!knownSeed || current.seedReviewRequired) return { kind: 'review' };
  if (current.seedTemplateRevision === desired.revision) return { kind: 'keep' };
  if ((current.seedTemplateRevision ?? 0) > desired.revision) return { kind: 'keep' };
  return {
    kind: 'update',
    seedTemplateKey: desired.key,
    seedTemplateRevision: desired.revision,
    seedDefinition: desired.definition,
  };
}
