import { describe, expect, it } from 'vitest';
import { emptyGoogleCalendarConnection } from './google-calendar-connection.js';
import { type MigrationRecord, validateMigrationReferences } from './migration.js';

const owner = '11111111-1111-4111-8111-111111111111';
const agent: MigrationRecord = {
  table: 'agents',
  collection: 'agents',
  id: owner,
  checksum: '',
  data: { id: owner },
};
const record = (data: MigrationRecord['data']): MigrationRecord => ({
  table: 'google_calendar_connections',
  collection: 'googleCalendarConnections',
  id: owner,
  checksum: '',
  data,
});
describe('Google Calendar migration ownership', () => {
  it('requires outer owner, nested owner and document identity to match the source', () => {
    const valid = { agentId: owner, state: emptyGoogleCalendarConnection(owner) };
    expect(() => validateMigrationReferences([agent, record(valid)], owner)).not.toThrow();
    for (const data of [
      { state: valid.state },
      { ...valid, agentId: 'other' },
      { ...valid, state: { ...valid.state, ownerId: 'other' } },
      { ...valid, state: { ownerId: owner } },
    ])
      expect(() => validateMigrationReferences([agent, record(data)], owner)).toThrow(
        /Google Calendar/,
      );
    expect(() =>
      validateMigrationReferences([agent, { ...record(valid), id: 'other' }], owner),
    ).toThrow(/Google Calendar/);
  });
});
