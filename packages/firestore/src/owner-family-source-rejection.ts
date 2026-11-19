/**
 * A rejected single-source family claim keeps its original note for inspection,
 * but the unchanged evidence must not be reused in recall or graph extraction.
 * The removal writer stamps this hash atomically with its durable marker and receipt.
 * A later content correction has a different hash and is new evidence.
 */
export function ownerFamilySourceIsRejected(memory: {
  contentHash: string;
  ownerFamilyRejectedContentHash?: unknown;
}): boolean {
  const rejected = memory.ownerFamilyRejectedContentHash;
  if (rejected === undefined || rejected === null) return false;
  if (typeof rejected !== 'string' || !/^[a-f0-9]{64}$/.test(rejected))
    throw new Error('Malformed owner family source rejection');
  return rejected === memory.contentHash;
}
