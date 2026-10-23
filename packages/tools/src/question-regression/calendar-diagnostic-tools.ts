import { registerCalendarReadTools } from '../google/calendar.js';
import { GoogleClient } from '../google/client.js';
import { ToolRegistry } from '../registry.js';
import type { QuestionToolFixture } from './corpus.js';

export type CalendarDiagnosticToolName =
  | 'calendar.list_events'
  | 'calendar.search_events'
  | 'calendar.list_calendars'
  | 'calendar.availability';

// Registration is pure. The transport is deliberately unusable, even if a
// future caller accidentally invokes a production handler while preparing.
const registry = registerCalendarReadTools(new ToolRegistry(), {
  client: new GoogleClient({
    clientId: 'synthetic-diagnostic',
    clientSecret: 'synthetic-diagnostic',
    refreshToken: 'synthetic-diagnostic',
    fetch: async () => {
      throw new Error('Calendar diagnostics must never invoke a provider transport');
    },
  }),
  botEmail: 'assistant@example.test',
  ownerEmail: 'owner@example.test',
});

/** Reuse production schemas, descriptions and policy; replace execution only. */
export function calendarReadToolFixture(
  name: CalendarDiagnosticToolName,
  outcomes: QuestionToolFixture['outcomes'],
): QuestionToolFixture {
  const registered = registry.get(name);
  if (!registered || typeof registered.tool.risk !== 'string')
    throw new Error(`Unsupported diagnostic read tool: ${name}`);
  return {
    name,
    description: registered.tool.description,
    schema: registered.tool.inputSchema,
    risk: registered.tool.risk,
    flags: registered.flags,
    acceptsUntrustedInput: registered.tool.acceptsUntrustedInput,
    outcomes,
  };
}
