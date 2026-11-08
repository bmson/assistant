/** Forwarded observation includes auto-archived received mail, but never outbound or junk. */
export function observableMailLabels(
  labels: readonly string[] | undefined,
  forwarded: boolean,
): boolean {
  if (!forwarded) return labels?.includes('INBOX') ?? false;
  // Gmail can omit the repeated labelIds field for a read, fully archived message.
  return !(labels ?? []).some((label) => ['SENT', 'DRAFT', 'SPAM', 'TRASH'].includes(label));
}
