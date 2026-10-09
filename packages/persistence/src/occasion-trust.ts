export function occasionTrustRank(trust: string): number {
  return ({ owner: 3, assistant: 2, known: 1, unknown: 0 } as Record<string, number>)[trust] ?? 0;
}

/** Lower-trust observations cannot become fields on an accepted occasion. */
export function canMergeOccasionObservation(
  current: { originTrust: string; quarantined: boolean; ownerConfirmed: boolean },
  incoming: { originTrust: string; quarantined: boolean },
): boolean {
  return (
    occasionTrustRank(incoming.originTrust) >= occasionTrustRank(current.originTrust) &&
    !(incoming.quarantined && !current.quarantined) &&
    !(current.ownerConfirmed && incoming.originTrust !== 'owner')
  );
}
