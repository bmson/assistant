/** Internal record builder shared by ordinary rotation and reviewed maintenance. */
import { ownerEditorPrivacyDigest, parseOwnerEditorEpochCursor } from '@assistant/persistence';
import { encodeRecord } from './store.js';

export function buildFirestoreOwnerEditorEpochRecord(input: {
  ownerId: string;
  epoch: string;
  ready: boolean;
  privacyGeneration: string | null;
  updatedAt: Date;
}) {
  const state = parseOwnerEditorEpochCursor({
    ownerId: input.ownerId,
    epoch: input.epoch,
    ready: input.ready,
    privacyGenerationDigest: ownerEditorPrivacyDigest(input.privacyGeneration),
  });
  return encodeRecord({
    name: `owner-editor-epoch:${state.ownerId}`,
    updatedAt: input.updatedAt,
    cursor: JSON.stringify(state),
  });
}
