/** Owner-authored exact calendar label. The source hint may qualify a phone label. */
export interface OwnerCalendarScope {
  name: string;
  source?: 'iphone';
}

/** Generic references such as "my calendar" remain on the all-calendar path. */
export function requestedOwnerCalendarScope(text: string): OwnerCalendarScope | undefined {
  const quoted = /["'“]([^"'“”]{1,60})["'”]\s+calendar\b/i.exec(text);
  const qualified =
    /\b(?:my|our|the)\s+(?:["'“]([^"'“”]{1,60})["'”]|([\p{L}\p{N}][\p{L}\p{N}'’&.-]*(?:\s+[\p{L}\p{N}][\p{L}\p{N}'’&.-]*){0,3}))\s+calendar\b/iu.exec(
      text,
    );
  const proper =
    /\b([\p{Lu}][\p{L}\p{N}'’&.-]*(?:\s+[\p{L}\p{N}][\p{L}\p{N}'’&.-]*){0,3})\s+calendar\b/u.exec(
      text,
    );
  const work = /\bwork\s+calendar\b/i.exec(text);
  const candidates = [
    quoted ? { match: quoted, name: quoted[1], quoted: true } : undefined,
    qualified
      ? { match: qualified, name: qualified[1] ?? qualified[2], quoted: Boolean(qualified[1]) }
      : undefined,
    proper ? { match: proper, name: proper[1], quoted: false } : undefined,
    work ? { match: work, name: work[0].replace(/\s+calendar$/i, ''), quoted: false } : undefined,
  ];
  const stopWords =
    /^(?:my|our|the|all|every|calendar|what|where|when|who|which|is|on|in|if|source|events?|for|next|this|week|today|tomorrow|plan|before|after|editing|edit|and|with|from|to|review|check|show|search|find|list|booking|emails?|gmail|mail|trip|flight|hotel)$/i;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const words = candidate.name?.trim().split(/\s+/u) ?? [];
    if (!candidate.quoted && /^(?:Check|Show|Search|Review|Find|Open|List)$/u.test(words[0] ?? ''))
      words.shift();
    if (
      !candidate.name?.trim() ||
      (!candidate.quoted && words.some((word) => stopWords.test(word)))
    )
      continue;
    const name = words.join(' ');
    if (!name) continue;
    const context = text.slice(
      candidate.match.index,
      candidate.match.index + candidate.match[0].length + 48,
    );
    return {
      name,
      ...(/\bshared\s+from\s+(?:my\s+)?phone\b/i.test(context)
        ? { source: 'iphone' as const }
        : {}),
    };
  }
  return undefined;
}

/** Tool-side exact-name resolver accepts either display names or IDs. */
export function ownerCalendarToolName(scope: OwnerCalendarScope): string {
  const name = scope.name.trim();
  if (scope.source === 'iphone' && !/\s+\(iphone\)$/i.test(name)) return `${name} (iPhone)`;
  return name;
}
