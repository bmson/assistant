/** Facts with historical, prospective or uncertain scope retain their own claims. */
export interface ConsolidationTemporalFact {
  content: string;
  createdAt: Date;
  validFrom: Date | null;
  validUntil: Date | null;
}
const scopedWording =
  /\b(?:may|might|possibly|perhaps|probably|reportedly|apparently|uncertain|unconfirmed|unknown|if|would|could|used to|formerly|former|previously|worked|lived|was|were|will|plans? to|since|until|before|after|yesterday|tomorrow|last|next|ago|during|in \d{4}|\d{4}[-–]\d{4})\b/i;
export function canRewriteConsolidationFacts(facts: ConsolidationTemporalFact[]): boolean {
  return (
    facts.length >= 2 &&
    facts.every(
      (fact) =>
        fact.validFrom === null && fact.validUntil === null && !scopedWording.test(fact.content),
    )
  );
}
export function earliestConsolidationSource(facts: ConsolidationTemporalFact[]): Date {
  if (!facts.length || facts.some((fact) => !Number.isFinite(fact.createdAt.getTime())))
    throw new Error('Consolidation source time is missing');
  return new Date(Math.min(...facts.map((fact) => fact.createdAt.getTime())));
}
