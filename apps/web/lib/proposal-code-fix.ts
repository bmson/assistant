import { reportRepair } from '@assistant/application';
import { loadConfig } from '@assistant/config';
import type { RepairIssue } from '@assistant/persistence';
import { getSelfRepairService } from './server';
import { decideOwnerImprovement, listOpenImprovements } from './workspace-reviews';

export interface ProposalCodeFixReceipt {
  outcome: 'code_fix_requested';
  enacted: false;
  detail: string;
  repairIssueId: string;
  repairStatus: RepairIssue['status'];
}

/** Repeating conversion may return a settled report; it never authorizes a new run. */
export function proposalCodeFixReceipt(
  issue: Pick<RepairIssue, 'id' | 'status'>,
): ProposalCodeFixReceipt {
  return {
    outcome: 'code_fix_requested',
    enacted: false,
    repairIssueId: issue.id,
    repairStatus: issue.status,
    detail:
      issue.status === 'reported'
        ? 'Code-fix report queued for investigation. No code has changed.'
        : 'A code-fix report already exists for this proposal. Review its current progress in Code fixes. No new coding run was requested.',
  };
}

/** Owner endpoints supply only an ID; the proposal content is always loaded from the owned store. */
export async function requestOwnerProposalCodeFix(id: string) {
  const config = loadConfig();
  if (
    !config.SELF_REPAIR_ENABLED ||
    !config.GITHUB_REPO ||
    (config.SELF_REPAIR_PROVIDER !== 'openai_hosted' && !config.GITHUB_TOKEN)
  )
    throw new Error('Configure and enable code fixes before requesting one');
  const { repository, agentId } = await getSelfRepairService();
  const existing = (await repository.list(agentId)).find((issue) => issue.data.proposalId === id);
  const proposal = (await listOpenImprovements()).find((row) => row.id === id);
  if (proposal?.kind === 'model_role') throw new Error('Model changes can be applied directly');
  if (existing) {
    if (proposal) await decideOwnerImprovement(id, 'apply');
    return existing;
  }
  if (!proposal) throw new Error('Open proposal not found');
  const change = (proposal.change ?? {}) as { suggestion?: unknown };
  const suggestion = typeof change.suggestion === 'string' ? change.suggestion : '';
  const issue = await reportRepair(repository, agentId, {
    source: 'proposal',
    key: proposal.id,
    proposalId: proposal.id,
    sourceTaskId: proposal.evidenceIds?.find((evidenceId) => /^[a-f0-9-]{36}$/i.test(evidenceId)),
    title: proposal.title,
    summary: `Owner requested a code change from this improvement proposal.\n\nObserved pattern: ${proposal.rationale}\n\nRequested behavior: ${suggestion || proposal.title}`,
  });
  // Creating the durable report comes first; a failed acknowledgement remains safe to repeat.
  await decideOwnerImprovement(id, 'apply');
  return issue;
}
