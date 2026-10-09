export type RenderedDocumentChunk = {
  chunkIndex: number;
  text: string;
  charCount: number;
  fragment?: { offset: number; totalChars: number; complete: boolean };
};

export function mergeDocumentPassagePage(
  current: RenderedDocumentChunk[],
  incoming: RenderedDocumentChunk[],
): RenderedDocumentChunk[] {
  const merged = new Map(current.map((chunk) => [chunk.chunkIndex, chunk]));
  for (const chunk of incoming) {
    const prior = merged.get(chunk.chunkIndex);
    if (!chunk.fragment) {
      if (!prior) merged.set(chunk.chunkIndex, chunk);
      continue;
    }
    if (!prior) {
      if (
        chunk.fragment.offset !== 0 ||
        chunk.fragment.offset + chunk.text.length > chunk.fragment.totalChars ||
        (chunk.fragment.complete &&
          chunk.fragment.offset + chunk.text.length !== chunk.fragment.totalChars)
      )
        throw new Error('Passage fragment has invalid bounds. Reload passages to continue.');
      merged.set(chunk.chunkIndex, chunk);
      continue;
    }
    if (!prior.fragment) continue;
    if (chunk.fragment.totalChars !== prior.fragment.totalChars)
      throw new Error('Passage changed while it was being read. Reload passages to continue.');
    if (chunk.fragment.offset < prior.text.length) continue;
    if (chunk.fragment.offset !== prior.text.length)
      throw new Error('Passage continuation is out of order. Reload passages to continue.');
    const text = prior.text + chunk.text;
    if (
      text.length > chunk.fragment.totalChars ||
      (chunk.fragment.complete && text.length !== chunk.fragment.totalChars)
    )
      throw new Error('Passage fragment has invalid bounds. Reload passages to continue.');
    merged.set(chunk.chunkIndex, { ...chunk, text, charCount: text.length });
  }
  return [...merged.values()].sort((left, right) => left.chunkIndex - right.chunkIndex);
}
