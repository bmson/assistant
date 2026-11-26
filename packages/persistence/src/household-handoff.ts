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
