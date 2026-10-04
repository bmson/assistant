'use server';

import type { ImprovementActionResult } from '@assistant/persistence';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import {
  type ProposalCodeFixReceipt,
  proposalCodeFixReceipt,
  requestOwnerProposalCodeFix,
} from '@/lib/proposal-code-fix';
import { decideOwnerImprovement } from '@/lib/workspace-reviews';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function revalidate(): void {
  revalidatePath('/improvements');
  revalidatePath('/settings');
}

/** Owner approves a proposal — enacts an applyable change, or acknowledges an advisory one. */
export async function applyProposalAction(id: string): Promise<ImprovementActionResult> {
  await requireOwner();
  if (!UUID_RE.test(id)) throw new Error('Invalid proposal id');
  const result = await decideOwnerImprovement(id, 'apply');
  revalidate();
  return result;
}

export async function dismissProposalAction(id: string): Promise<ImprovementActionResult> {
  await requireOwner();
  if (!UUID_RE.test(id)) throw new Error('Invalid proposal id');
  const result = await decideOwnerImprovement(id, 'dismiss');
  revalidate();
  return result;
}

export async function requestProposalCodeFixAction(id: string): Promise<ProposalCodeFixReceipt> {
  await requireOwner();
  if (!UUID_RE.test(id)) throw new Error('Invalid proposal id');
  const issue = await requestOwnerProposalCodeFix(id);
  revalidate();
  return proposalCodeFixReceipt(issue);
}
