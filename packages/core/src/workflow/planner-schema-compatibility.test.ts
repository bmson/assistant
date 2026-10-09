import { zodSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import { MissionCadenceSchema, PlanSchema } from '../events.js';

type JsonSchema = {
  properties?: Record<string, JsonSchema>;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  [key: string]: unknown;
};

function containsKeyword(value: unknown, keyword: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsKeyword(entry, keyword));
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    keyword in record || Object.values(record).some((entry) => containsKeyword(entry, keyword))
  );
}

describe('planner structured-output schema compatibility', () => {
  it('uses the OpenAI-supported anyOf representation for mission cadence', async () => {
    const schema = (await zodSchema(PlanSchema).jsonSchema) as JsonSchema;
    const cadence = schema.properties?.cadence;

    expect(cadence?.anyOf).toHaveLength(2);
    expect(cadence?.oneOf).toBeUndefined();
    expect(containsKeyword(schema, 'oneOf')).toBe(false);
  });

  it('retains the same cadence validation for both variants and invalid values', () => {
    expect(MissionCadenceSchema.parse({ kind: 'interval', everyMinutes: 60 })).toEqual({
      kind: 'interval',
      everyMinutes: 60,
    });
    expect(
      MissionCadenceSchema.parse({
        kind: 'local_times',
        timezone: 'America/Los_Angeles',
        times: ['08:30', '19:00'],
        daysOfWeek: [1, 3, 5],
      }),
    ).toEqual({
      kind: 'local_times',
      timezone: 'America/Los_Angeles',
      times: ['08:30', '19:00'],
      daysOfWeek: [1, 3, 5],
    });
    expect(MissionCadenceSchema.safeParse({ kind: 'interval', everyMinutes: 5 }).success).toBe(
      false,
    );
    expect(
      MissionCadenceSchema.safeParse({
        kind: 'local_times',
        timezone: 'America/Los_Angeles',
        times: ['08:30', '08:30'],
      }).success,
    ).toBe(false);
  });
});
