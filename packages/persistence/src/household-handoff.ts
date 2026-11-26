import { createHash } from 'node:crypto';
import { z } from 'zod';

const id = z.string().trim().min(1).max(512);
const time = z.string().datetime({ offset: true });
const origin = z.string().trim().min(3).max(180);
const phone = z.string().regex(/^\+[1-9]\d{7,14}$/);

export const handoffAppointment = z
  .object({
    calendarId: id,
    eventId: id,
    subjectId: id,
    start: time,
    end: time,
    destination: origin,
  })
  .strict();

export const handoffPlan = z
  .object({
    id: z.string().uuid(),
    connectionId: z.string().uuid(),
    ownerContactId: id,
    recipientId: id,
    recipientEmail: z.string().email().max(254),
    recipientPhone: phone,
    ownerCalendarIds: z
      .array(id)
      .min(1)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length),
    ownerOrigin: origin,
    keeps: handoffAppointment,
    currentlyCovers: handoffAppointment,
    availabilityStart: time,
    availabilityEnd: time,
    sharing: z
      .object({
        googleSubject: id,
        tripOrigin: origin,
      })
      .strict()
      .nullable(),
  })
  .strict();

export const householdHandoffRecord = z
  .object({
    agentId: z.string().uuid(),
    revision: z.string().uuid(),
    plan: handoffPlan.nullable(),
  })
  .strict();

export type HouseholdHandoffRecord = z.infer<typeof householdHandoffRecord>;
export type HouseholdHandoffPlan = z.infer<typeof handoffPlan>;
export interface HouseholdHandoffRepository {
  read(agentId: string): Promise<HouseholdHandoffRecord | null>;
  change(expectedRevision: string | null, next: HouseholdHandoffRecord): Promise<boolean>;
}

// Each transport boundary rotates invitation and CAS identities. Derive the
// replacements deterministically so import preview, retries and verify agree.
export function householdHandoffAfterTransfer(
  value: unknown,
  ownerId: string,
  stage: 'export' | 'import',
  target: { projectId: string; databaseId: string; installationId: string },
): HouseholdHandoffRecord {
  const record = householdHandoffRecord.parse(value);
  if (record.agentId !== ownerId) throw new Error('Invalid household handoff migration owner');
  const rotate = (kind: 'plan' | 'revision', id: string) => {
    const hex = createHash('sha256')
      .update(
        JSON.stringify([
          'household-handoff-transfer-v1',
          stage,
          target.projectId,
          target.databaseId,
          target.installationId,
          kind,
          ownerId,
          id,
        ]),
      )
      .digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  return {
    ...record,
    revision: rotate('revision', record.revision),
    plan: record.plan
      ? { ...record.plan, id: rotate('plan', record.plan.id), sharing: null }
      : null,
  };
}
