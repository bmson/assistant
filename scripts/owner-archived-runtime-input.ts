import { resolve } from 'node:path';
import { readArchivedRuntimePack } from './owner-archived-runtime-pack.js';
import { verifyArchivedRuntimeProvenance } from './owner-archived-runtime-provenance.js';

// This fingerprint covers both historical images and their native baseline.
export const ARCHIVED_RUNTIME_PACK_SHA256 =
  'cbf60ddcd176546d5944536e2aef3619acd2d8623b3c8dc699ec10e2886a0b94';

export async function loadReviewedArchivedRuntimePack() {
  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp) throw new Error('Missing protected runner directory');
  return loadReviewedArchivedRuntimePackAt(resolve(runnerTemp, 'owner-archived-runtime-pack'));
}

export async function loadReviewedArchivedRuntimePackAt(directory: string) {
  const pack = await readArchivedRuntimePack(directory, ARCHIVED_RUNTIME_PACK_SHA256);
  await verifyArchivedRuntimeProvenance(pack.roles, pack.trustedRoot);
  return pack;
}
