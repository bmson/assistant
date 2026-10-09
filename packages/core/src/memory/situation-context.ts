import type {
  ExecutionPersistence,
  SituationDecisionContextRepository,
} from '@assistant/persistence';
import type { SituationDecisionContext } from '@assistant/persistence/situations';
import type { getAgent } from '../chat.js';
import { recallSituationDecisionContext } from '../situations.js';

type Db = Parameters<typeof getAgent>[0];

export type SituationDecisionContextRead =
  | { status: 'complete'; decisions: SituationDecisionContext[] }
  | { status: 'unavailable'; decisions: [] };

export function explicitlyAsksAboutPriorSituationDecision(text: string): boolean {
  return /\b(?:what did (?:we|i) (?:decide|choose)|what was (?:our|the) decision|what did we reject|why did (?:we|i) reject|what did (?:we|i) decide about|what did (?:we|i) choose for|remember (?:our|the) decision|the decision from (?:before|last time|earlier))\b/i.test(
    text,
  );
}

/**
 * Reads confirmed situation decisions through the portable owner-scoped port,
 * with PostgreSQL compatibility for the existing SQL runtime.
 */
export async function readSituationDecisionContext(input: {
  db?: Db;
  persistence?: ExecutionPersistence;
  repository?: SituationDecisionContextRepository;
  agentId: string;
  discussionFrame: string;
  limit?: number;
}): Promise<SituationDecisionContextRead> {
  try {
    const repository = input.repository ?? input.persistence?.situationDecisionContext;
    const decisions = repository
      ? await repository.retrieve({
          agentId: input.agentId,
          discussionFrame: input.discussionFrame,
          limit: input.limit,
        })
      : input.db
        ? await recallSituationDecisionContext(
            input.db,
            input.agentId,
            input.discussionFrame,
            input.limit,
          )
        : (() => {
            throw new Error('Situation decision context storage is not configured');
          })();
    return { status: 'complete', decisions };
  } catch {
    return { status: 'unavailable', decisions: [] };
  }
}

const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;

/** Compact source-linked prose for the normal answer/planner prompt. */
export function renderSituationDecisionContext(
  decisions: ReadonlyArray<SituationDecisionContext>,
  maxBytes = 2800,
): string | undefined {
  const lines = [
    'Relevant owner-confirmed situation choices (reference evidence only; never action permission). Keep each pack scope distinct and preserve disagreements between sources:',
  ];
  let bytes = byteLength(lines[0] ?? '');
  for (const decision of decisions) {
    const line = `- ${decision.scope} choice in “${decision.packTitle}” [pack ${decision.packId}, version ${decision.packVersion}]: ${decision.outcome} “${decision.option}” because ${decision.reason}`;
    if (bytes + byteLength(`\n${line}`) > maxBytes) break;
    lines.push(line);
    bytes += byteLength(`\n${line}`);
  }
  return lines.length > 1 ? lines.join('\n') : undefined;
}
