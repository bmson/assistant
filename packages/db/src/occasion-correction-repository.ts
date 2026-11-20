import type {
  OccasionCorrectionRepository,
  OccasionCorrectionResult,
} from '@assistant/persistence';
import {
  isOccasionCorrectionDate,
  occasionCorrectionReadback,
  sameOccasionContactName,
} from '@assistant/persistence';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { assertPostgresInstallationOwner } from './installation-owner.js';
import { withPostgresPrivacyObservationFence } from './privacy-erasure-repository.js';
import { contacts, occasions } from './schema.js';

const CONTACT_SCAN_LIMIT = 5000;

export function createPostgresOccasionCorrectionRepository(db: Db): OccasionCorrectionRepository {
  return {
    async correct(input): Promise<OccasionCorrectionResult> {
      try {
        return await withPostgresPrivacyObservationFence(db, input.agentId, async (tx) => {
          await assertPostgresInstallationOwner(tx, input.agentId);
          const people = await tx
            .select({ id: contacts.id, name: contacts.name })
            .from(contacts)
            .limit(CONTACT_SCAN_LIMIT + 1);
          if (people.length > CONTACT_SCAN_LIMIT)
            throw new Error('Occasion contact lookup exceeded bound');
          const matchingPeople = people.filter(({ name }) =>
            sameOccasionContactName(name, input.subject),
          );
          if (matchingPeople.length > 1) return { outcome: 'ambiguous_contact' };
          const person = matchingPeople[0];
          if (!person) return { outcome: 'contact_not_found' };
          const [lockedPerson] = await tx
            .select({ name: contacts.name })
            .from(contacts)
            .where(and(eq(contacts.id, person.id), eq(contacts.name, person.name)))
            .for('share');
          if (!lockedPerson) return { outcome: 'contact_not_found' };

          const { expectedDate } = input;
          const oldIdentity = and(
            eq(occasions.agentId, input.agentId),
            eq(occasions.contactId, person.id),
            eq(occasions.kind, input.kind),
            eq(occasions.month, expectedDate.month),
            eq(occasions.day, expectedDate.day),
          );
          const [old] = await tx.select().from(occasions).where(oldIdentity).for('update');
          if (
            !old ||
            old.quarantined ||
            (input.label !== undefined && input.label !== old.label) ||
            (expectedDate.year !== undefined && expectedDate.year !== old.year)
          )
            return { outcome: 'occasion_not_found' };

          const date = {
            ...input.date,
            year: input.date.year === undefined ? old.year : input.date.year,
          };
          if (!isOccasionCorrectionDate(date)) return { outcome: 'invalid_date' };
          if (old.month === date.month && old.day === date.day && old.year === date.year)
            return { outcome: 'unchanged', occasion: occasionCorrectionReadback(old, person.name) };

          // Match the Profile update on the same row. Only the date and update
          // timestamp change, and the unique index still governs the destination.
          const [saved] = await tx
            .update(occasions)
            .set({ ...date, updatedAt: sql`now()` })
            .where(
              and(
                eq(occasions.id, old.id),
                oldIdentity,
                eq(occasions.label, old.label),
                eq(occasions.quarantined, false),
                old.year === null ? isNull(occasions.year) : eq(occasions.year, old.year),
              ),
            )
            .returning();
          if (!saved) return { outcome: 'occasion_not_found' };
          return { outcome: 'updated', occasion: occasionCorrectionReadback(saved, person.name) };
        });
      } catch (error) {
        const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : error;
        if (
          cause &&
          typeof cause === 'object' &&
          'code' in cause &&
          cause.code === '23505' &&
          'constraint_name' in cause &&
          cause.constraint_name === 'occasions_dedup_idx'
        )
          return { outcome: 'date_conflict' };
        throw error;
      }
    },
  };
}
