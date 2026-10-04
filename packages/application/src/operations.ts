import { getAgent } from '@assistant/core/chat';
import {
  deleteSkill,
  listSkills,
  saveSkill,
  setSkillDeprecated,
  updateSkill,
} from '@assistant/core/memory/skills';
import type { ModelRouter } from '@assistant/core/model-router';
import {
  dismissAnomaly,
  listOpenAnomalies,
  suspendAnomalyPolicy,
} from '@assistant/core/workflow/anomaly';
import {
  applyProposal,
  dismissProposal,
  listOpenProposals,
} from '@assistant/core/workflow/improve';
import type { Db } from '@assistant/db';
import type { ImprovementActionResult } from '@assistant/persistence';

export async function listAnomalies(db: Db) {
  const agent = await getAgent(db);
  return listOpenAnomalies(db, agent.id);
}

export function dismissAnomalyRecord(db: Db, anomalyId: string): Promise<void> {
  return dismissAnomaly(db, anomalyId);
}

export async function suspendAnomalyRecord(db: Db, anomalyId: string): Promise<void> {
  await suspendAnomalyPolicy(db, anomalyId);
}

export async function listImprovementProposals(db: Db) {
  const agent = await getAgent(db);
  return listOpenProposals(db, agent.id);
}

export async function applyImprovementProposal(
  db: Db,
  id: string,
): Promise<ImprovementActionResult> {
  const agent = await getAgent(db);
  return applyProposal(db, id, agent.id);
}

export async function dismissImprovementProposal(
  db: Db,
  id: string,
): Promise<ImprovementActionResult> {
  const agent = await getAgent(db);
  return dismissProposal(db, id, agent.id);
}

export async function listAssistantSkills(db: Db) {
  const agent = await getAgent(db);
  return listSkills(db, agent.id);
}

export async function addAssistantSkill(
  db: Db,
  router: ModelRouter,
  input: { name: string; preconditions: string; steps: string; gotchas: string },
): Promise<{ error?: string }> {
  const name = input.name.trim();
  const steps = input.steps.trim();
  if (!name) return { error: 'Give the skill a name.' };
  if (!steps) return { error: 'Describe the steps.' };
  const agent = await getAgent(db);
  try {
    await saveSkill(db, router, {
      agentId: agent.id,
      name,
      preconditions: input.preconditions,
      steps,
      gotchas: input.gotchas,
      originTrust: 'owner',
      ownerAuthored: true,
    });
    return {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Skill could not be saved.' };
  }
}

export async function editAssistantSkill(
  db: Db,
  router: ModelRouter,
  skillId: string,
  patch: { name: string; preconditions: string; steps: string; gotchas: string },
): Promise<{ error?: string }> {
  if (!patch.name.trim() || !patch.steps.trim()) {
    return { error: 'Name and steps are required.' };
  }
  await updateSkill(db, router, skillId, patch);
  return {};
}

export function deleteAssistantSkill(db: Db, skillId: string): Promise<void> {
  return deleteSkill(db, skillId);
}

export function setAssistantSkillDeprecated(
  db: Db,
  skillId: string,
  deprecated: boolean,
): Promise<void> {
  return setSkillDeprecated(db, skillId, deprecated);
}
