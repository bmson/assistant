/**
 * Keep complete evidence entries inside the entire prompt-block budget,
 * including its provenance/trust header and separators. Never truncate a
 * relationship or quotation midway and then present it as complete evidence.
 */
export function createRecallBlock(header: string, maxChars: number) {
  const budget = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
  const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
  let text = '';
  return {
    add(entry: string): boolean {
      const next = text ? `${text}\n${entry}` : `${header}\n\n${entry}`;
      if (!entry || bytes(next) > budget) return false;
      text = next;
      return true;
    },
    get text(): string {
      return text;
    },
    get available(): boolean {
      return budget > bytes(header) + 2;
    },
  };
}
