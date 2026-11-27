/** Source-reviewed projection of the operator's original web-pin operation. Only
 * resource identifiers and digests are public. Raw native observations and
 * signed release evidence remain in private release storage. */
import { createHash } from 'node:crypto';
import { loadRetainedServingImageEvidence } from './owner-serving-image-evidence.js';

const reviewed = {
  format: 1,
  kind: 'ordinary-web-canonical-recovery',
  source: 'd6954975b72e5cf41357f050d9d6b036ccad7753',
  runId: '44679671412',
  attempt: '1',
  canonicalRevision: 'assistant-web-r-44679671412-1-d6954975',
  candidateRevision: 'assistant-web-p-44679671412-1-d6954975',
  canonicalServiceUidSha256: 'f5c2b6c7b021f8d3e663783334bb8ca1241075aad848cfd24acb25d753b06364',
  canonicalRevisionUidSha256: 'd42ba15d8bfc77ef42b3b274330ffef9766fb394aadf2cf7e9ed56a39d7a5f87',
  canonicalRevisionSha256: '2c7e0644d233e697da6781c531b5dd4d9c6d74462a9cfc3423d969a8c5023ab5',
  canonicalImage:
    'us-west1-docker.pkg.dev/bmson-assistant/assistant/web@sha256:19f1750ac9d36b8fd4556c6132f3ddf75e20b6b7d020068a87902301385bf9c4',
  retiredAliases: {
    candidate: {
      tag: 'candidate-44679671412-1',
      uriSha256: '991f0f42feddf5749ab0384a7652043b173d7fa810a3c5589f557f3b1504d9ce',
    },
    resume: {
      tag: 'resume-44679671412-1',
      uriSha256: '28914009d90d47aec3f7cf12401f7225035ea6ba310eaf5389b7c43fd5b4e9ad',
    },
  },
  priorBarrierSha256: '0472225175d7df3cb3c51281f282663a8734363044d656462e44da2ffed2445f',
  barrierArchiveSha256: '63c14970740faaee885851570d631b014e383aedf827afd1e26f13a1b6f7a348',
  webPin: {
    requestSha256: '9c78a3958e6f1e3588a4f017fcf5209a671745cb33c764f501dcd29d4a32777b',
    beforeSha256: '9148733f722df70de903c4402173a61591e68db107c0184b876ce844dd6f2a2b',
    operationNameSha256: 'd20b9e5f10482e564227a2744220a2feeee84405216efefc198af24410a4f343',
    terminalSha256: 'f5313d4beb334e814c6f62ffb216220f5673feaea115be8ac6ebe1f27b0536fd',
    afterSha256: '547657ce87b7af7fdda7b0ba2b665cf282ca371969668d4c656dfb8aa5ff253f',
    effectSha256: '988a307174df64ccbb70793c0c7447528396cd903bfc1c1dbebd692a6d540fb6',
  },
  hostedCreationArtifactId: '14604345847',
  hostedBarrierArtifactId: '14603604699',
} as const;
const evidenceSha256 = '08e6a3a411f3ccf15ef6f946508e8275598e38116fc5ad9c43a34822d01de097';

/** Select only for an installed ordinary recovery. Callers bind the historical
 * projection to the current service, raw revision and hosted candidate receipt. */
export function loadOrdinaryCanonicalRecovery(env: NodeJS.ProcessEnv = process.env) {
  const serving = loadRetainedServingImageEvidence(env);
  if (!serving) return undefined;
  const digest = createHash('sha256').update(JSON.stringify(reviewed)).update('\n').digest('hex');
  if (digest !== evidenceSha256 || !serving.registerServingImage(reviewed.canonicalImage))
    throw new Error('Reviewed ordinary web recovery evidence held');
  return {
    ...reviewed,
    candidateTag: reviewed.retiredAliases.candidate.tag,
    evidenceSha256,
  };
}
