/** Owner-facing progress text shared by web and mobile Activity projections. */
export function activityProgress(status: string, rawProgress: string): string {
  if (status === 'cancelled') return 'This task was cancelled.';

  // Task progress is also the worker's bounded diagnostic field. A retry can
  // persist provider exception names and response URLs there; keep those in
  // storage for support, but do not turn them into owner-facing Activity copy.
  if (/\bAI_(?:APICallError|RetryError)\b|^attempt\s+\d+\s+failed:/iu.test(rawProgress))
    return 'A provider request failed. You can retry this task from Activity.';

  return rawProgress;
}
