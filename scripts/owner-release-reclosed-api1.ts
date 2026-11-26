import { bootstrapDigest, object, requireProof } from './owner-release-current-snapshot.js';

const runPattern = /^[1-9][0-9]{0,19}$/;
const sourcePattern = /^[0-9a-f]{40}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const checkedJournal = Symbol('checked predecessor journal');

type PredecessorIdentity = {
  source: string;
  runId: string;
  attempt: '1';
  manifestDigest: string;
};

function exactMarker(
  raw: unknown,
  identity: PredecessorIdentity,
  proofSha256: string,
  phase: 'started' | 'interrupted',
) {
  requireProof(
    bootstrapDigest(object(raw)) ===
      bootstrapDigest({
        format: 1,
        source: identity.source,
        runId: identity.runId,
        attempt: identity.attempt,
        phase,
        decision: phase === 'started' ? 'verified' : 'rehydrate_original_children',
        proofSha256,
        mutationAuthorized: false,
        observationRequired: phase === 'interrupted',
      }),
  );
}

/** The caller authenticates the failed protected run, its handoff and immutable
 * artifact metadata. Refuse any journal except the exact two-member pre-admission
 * archive. Empty/missing journals or incomplete ZIP inventories cannot certify it.
 */
export function verifyReclosedPredecessorJournal(
  identity: PredecessorIdentity,
  expectedProofSha256: string,
  files: Readonly<Record<string, unknown>>,
) {
  requireProof(
    sourcePattern.test(identity.source) &&
      runPattern.test(identity.runId) &&
      identity.attempt === '1' &&
      hashPattern.test(identity.manifestDigest) &&
      hashPattern.test(expectedProofSha256) &&
      Object.keys(files).sort().join(',') === 'outcome.json,start.json',
  );
  exactMarker(files['start.json'], identity, expectedProofSha256, 'started');
  exactMarker(files['outcome.json'], identity, expectedProofSha256, 'interrupted');
  return Object.freeze({ ...identity, [checkedJournal]: true as const });
}
