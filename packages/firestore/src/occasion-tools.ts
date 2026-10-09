import type {
  OccasionToolRepository,
  OccasionToolRow,
  OccasionToolSaveInput,
  Records,
} from '@assistant/persistence';
import { resolveFirestoreSubjectContact } from './contact-lookup.js';
import {
  FirestoreProfileOccasionCommandRepository,
  OccasionDateCorrectionConflictError,
} from './profile-occasion-command.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

/** Every occasion is needed to compute what is upcoming; past this bound the read fails. */
const OCCASION_SCAN_LIMIT = 5000;

/**
 * The model's occasion tools over the same records and dedup key as the
 * owner's Profile occasions. A tool save keeps its own provenance, so an
 * untrusted session's date stays quarantined until the owner reviews it.
 */
export class FirestoreOccasionToolRepository implements OccasionToolRepository {
  private readonly commands: FirestoreProfileOccasionCommandRepository;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {
    this.commands = new FirestoreProfileOccasionCommandRepository(store, configuredAgentId);
  }

  private owner(agentId: string): string {
    if (!agentId || agentId !== this.configuredAgentId)
      throw new Error('Occasion owner is outside the configured Firestore agent');
    return agentId;
  }

  async save(input: OccasionToolSaveInput): Promise<{ saved: boolean } | null> {
    const agentId = this.owner(input.agentId);
    const contactId = await resolveFirestoreSubjectContact(this.store, agentId, input.subject);
    if (!contactId) return null;
    try {
      const result = await this.commands.record(
        {
          contactId,
          kind: input.kind,
          label: input.label.slice(0, 120),
          month: input.month,
          day: input.day,
          year: input.year,
          leadDays: input.leadDays,
          notes: input.notes.trim().slice(0, 2000),
        },
        {
          originTrust: input.originTrust,
          quarantined: input.quarantined,
          ownerConfirmed: false,
          source: input.source,
        },
      );
      return { saved: result.created };
    } catch (error) {
      if (error instanceof OccasionDateCorrectionConflictError) return { saved: false };
      throw error;
    }
  }

  async list(agentId: string): Promise<OccasionToolRow[]> {
    this.owner(agentId);
    const page = await this.store
      .collection('occasions')
      .where('agentId', '==', agentId)
      .limit(OCCASION_SCAN_LIMIT + 1)
      .get();
    if (page.size > OCCASION_SCAN_LIMIT) throw new Error('Firestore occasion scan exceeded bound');
    const occasions = page.docs.flatMap((doc) => {
      const row = decodeRecord<Records['occasions']>(doc.data());
      if (
        typeof row.id !== 'string' ||
        documentKey(row.id) !== doc.id ||
        row.agentId !== agentId ||
        typeof row.contactId !== 'string' ||
        !Number.isInteger(row.month) ||
        !Number.isInteger(row.day) ||
        (row.year !== null && !Number.isInteger(row.year))
      )
        throw new Error('Occasion record is malformed');
      return row.quarantined === false ? [row] : [];
    });
    const contactIds = [...new Set(occasions.map((row) => row.contactId))];
    const names = new Map<string, string>();
    for (let offset = 0; offset < contactIds.length; offset += 200) {
      const ids = contactIds.slice(offset, offset + 200);
      const docs = await this.store.db.getAll(...ids.map((id) => this.store.doc('contacts', id)));
      docs.forEach((doc, index) => {
        const id = ids[index];
        if (!id || !doc.exists) return;
        const contact = decodeRecord<Records['contacts'] & { agentId?: unknown }>(doc.data());
        if (
          contact.id === id &&
          documentKey(id) === doc.id &&
          typeof contact.name === 'string' &&
          (contact.agentId === undefined || contact.agentId === agentId)
        )
          names.set(id, contact.name);
      });
    }
    // Like the SQL join, an occasion whose person is gone is not listed.
    return occasions.flatMap((row) => {
      const contactName = names.get(row.contactId);
      return contactName === undefined
        ? []
        : [
            {
              id: row.id,
              contactId: row.contactId,
              contactName,
              kind: row.kind,
              label: row.label,
              month: row.month,
              day: row.day,
              year: row.year,
              recurrence: row.recurrence,
              leadDays: row.leadDays,
              notes: row.notes,
            },
          ];
    });
  }
}
