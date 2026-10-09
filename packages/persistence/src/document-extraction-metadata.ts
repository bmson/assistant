/** Worker-owned format coverage, retained independently of extracted passages. */
export type DocumentExtractionMetadata = {
  version: 1;
  source: 'processor';
  chars: number | null;
  structure: {
    complete: true;
    representation: 'cell-addresses' | 'ordered-slides';
  } | null;
};

/** Missing legacy coverage is unknown; malformed advertised coverage is rejected. */
export function documentExtractionMetadata(input: {
  chars?: unknown;
  structure?: unknown;
}): DocumentExtractionMetadata {
  if (
    input.chars !== undefined &&
    (!Number.isSafeInteger(input.chars) || (input.chars as number) < 0)
  )
    throw new TypeError('Invalid document extraction character count');
  let structure: DocumentExtractionMetadata['structure'] = null;
  if (input.structure !== undefined) {
    const candidate = input.structure;
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate) ||
      Object.keys(candidate).some((key) => !['complete', 'representation'].includes(key)) ||
      !('complete' in candidate) ||
      candidate.complete !== true ||
      !('representation' in candidate) ||
      !['cell-addresses', 'ordered-slides'].includes(String(candidate.representation))
    )
      throw new TypeError('Invalid document extraction structure coverage');
    structure = {
      complete: true,
      representation: candidate.representation as 'cell-addresses' | 'ordered-slides',
    };
  }
  return {
    version: 1,
    source: 'processor',
    chars: (input.chars as number | undefined) ?? null,
    structure,
  };
}
