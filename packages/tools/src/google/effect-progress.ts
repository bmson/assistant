import type { ExternalEffectProgress } from '@assistant/persistence';
import type { ToolContext } from '../types.js';

export type GoogleEffectReceipt = Omit<ExternalEffectProgress, 'payloadDigest'>;

export class PartialGoogleArtifactError extends Error {
  readonly retrySuppressed = true;
  constructor(
    readonly progress: GoogleEffectReceipt,
    cause: unknown,
  ) {
    super(
      'Google created an external object, but completion could not be established; inspect the recorded object before retrying.',
      { cause },
    );
  }
}

export async function checkpointGoogleEffect(
  ctx: ToolContext,
  progress: GoogleEffectReceipt,
): Promise<void> {
  await ctx?.checkpointExternalEffect?.({ ...progress });
}
