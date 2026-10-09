/** Narrow flight label check used only to suppress time-specific proactive travel nudges. */
export function isFlightLikeCalendarEvent(event: {
  summary: string;
  description?: string;
}): boolean {
  return /\b(?:flight|airline|boarding(?: pass)?|itinerary)\b/i.test(
    `${event.summary}\n${event.description ?? ''}`.normalize('NFKC'),
  );
}
