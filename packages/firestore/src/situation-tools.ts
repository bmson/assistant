import type {
  SituationDecisionContextRepository,
  SituationToolRepository,
} from '@assistant/persistence';
import { FirestoreSituationPackMutationRepository } from './situation-pack-mutations.js';
import { FirestoreSituationPackReadRepository } from './situation-packs.js';
import type { InstallationStore } from './store.js';

/** The `situations.*` tools over the same pack reads and commands the owner UI uses. */
export class FirestoreSituationToolRepository
  implements SituationToolRepository, SituationDecisionContextRepository
{
  readonly kind = 'situation-decision-context-repository' as const;
  private readonly reads: FirestoreSituationPackReadRepository;
  private readonly mutations: FirestoreSituationPackMutationRepository;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {
    this.reads = new FirestoreSituationPackReadRepository(store);
    this.mutations = new FirestoreSituationPackMutationRepository(store, configuredAgentId);
  }

  private owner(agentId: string): string {
    if (!agentId || agentId !== this.configuredAgentId)
      throw new Error('Situation pack owner is outside the configured Firestore agent');
    return agentId;
  }

  list(agentId: string) {
    return this.reads.list(this.owner(agentId));
  }

  get(agentId: string, packId: string) {
    return this.reads.get(this.owner(agentId), packId);
  }

  sources(agentId: string) {
    return this.reads.listSources(this.owner(agentId));
  }

  decisions(agentId: string, query: string, packId?: string) {
    return this.reads.decisions(this.owner(agentId), query, packId);
  }

  retrieve(input: { agentId: string; discussionFrame: string; limit?: number }) {
    return this.reads.decisionContext(
      this.owner(input.agentId),
      input.discussionFrame,
      input.limit,
    );
  }

  command(agentId: string, input: unknown) {
    this.owner(agentId);
    // The model can never confirm a lasting preference; only the owner UI can.
    return this.mutations.command(input);
  }
}
