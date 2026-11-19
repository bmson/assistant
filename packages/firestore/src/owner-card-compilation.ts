import {
  MAX_OWNER_CARD_CONTACT_SCAN,
  MAX_OWNER_CARD_MEMORY_SCAN,
  type OwnerCardCompilationRepository,
  type OwnerCardFactInput,
} from '@assistant/persistence';
import {
  type DocumentSnapshot,
  FieldPath,
  type Query,
  type QueryDocumentSnapshot,
} from '@google-cloud/firestore';
import { ownerFamilySourceIsRejected } from './owner-family-source-rejection.js';
import { privacyErasureIsActive } from './privacy-erasure.js';
import { decodeRecord, documentKey, encodeRecord, type InstallationStore } from './store.js';

const PAGE_SIZE = 500;

interface CompilationMemory extends OwnerCardFactInput {
  id: string;
  agentId: string;
  contentHash: string;
  subjectContactId: string | null;
  category: string;
  expiresAt: Date | null;
}

interface CompilationContact {
  id: string;
  name: string;
  relationship: string;
  trust: string;
}

function active(row: CompilationMemory, now: Date): boolean {
  return !row.expiresAt || row.expiresAt > now;
}

function fact(row: CompilationMemory): OwnerCardFactInput {
  return {
    content: row.content,
    domain: row.domain,
    importance: row.importance,
    confidence: row.confidence,
    pinned: row.pinned,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
  };
}

/** Transactional, bounded Firestore input selection and publication for the owner card. */
export class FirestoreOwnerCardCompilationRepository implements OwnerCardCompilationRepository {
  readonly kind = 'owner-card-compilation-repository' as const;

  constructor(readonly store: InstallationStore) {}

  async compile(input: {
    agentId: string;
    now: Date;
    render: Parameters<OwnerCardCompilationRepository['compile']>[0]['render'];
  }) {
    if (!input.agentId) throw new Error('Owner card compilation requires an agent ID');
    const cardRef = this.store.doc('ownerCards', input.agentId);
    return this.store.db.runTransaction(async (tx) => {
      await tx.get(cardRef);
      const erasure = await tx.get(this.store.doc('privacyErasureJobs', input.agentId));
      if (erasure.exists && privacyErasureIsActive(erasure.get('status'))) return '';
      const readBounded = async (base: Query, maximum: number, label: string) => {
        const docs: QueryDocumentSnapshot[] = [];
        let cursor: QueryDocumentSnapshot | undefined;
        while (docs.length <= maximum) {
          let query = base.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
          if (cursor) query = query.startAfter(cursor);
          const page = await tx.get(query);
          docs.push(...page.docs);
          if (page.size < PAGE_SIZE) break;
          cursor = page.docs.at(-1);
        }
        if (docs.length > maximum) throw new Error(`Owner card ${label} scan exceeded ${maximum}`);
        return docs;
      };
      const contactDocs = await readBounded(
        this.store.collection('contacts').select('id', 'name', 'relationship', 'trust'),
        MAX_OWNER_CARD_CONTACT_SCAN,
        'contact',
      );
      const contacts = contactDocs
        .map((snapshot) => ({
          snapshot,
          row: decodeRecord<CompilationContact>(snapshot.data()),
        }))
        .filter(({ snapshot, row }) => row.id && documentKey(row.id) === snapshot.id)
        .map(({ row }) => row);
      const memoryDocs = await readBounded(
        this.store
          .collection('memories')
          .where('agentId', '==', input.agentId)
          .where('quarantined', '==', false)
          .where('supersededById', '==', null)
          .select(
            'id',
            'agentId',
            'content',
            'contentHash',
            'ownerFamilyRejectedContentHash',
            'subjectContactId',
            'category',
            'expiresAt',
            'domain',
            'importance',
            'confidence',
            'pinned',
            'validFrom',
            'validUntil',
          ),
        MAX_OWNER_CARD_MEMORY_SCAN,
        'memory',
      );
      const memories = memoryDocs
        .map((snapshot) => ({
          snapshot,
          row: decodeRecord<CompilationMemory>(snapshot.data()),
        }))
        .filter(
          ({ snapshot, row }) =>
            row.id &&
            documentKey(row.id) === snapshot.id &&
            row.agentId === input.agentId &&
            active(row, input.now),
        )
        .map(({ row }) => row);
      const tombstones: DocumentSnapshot[] = [];
      for (let index = 0; index < memories.length; index += PAGE_SIZE) {
        const refs = memories
          .slice(index, index + PAGE_SIZE)
          .map((row) => this.store.doc('memoryTombstones', row.contentHash));
        if (refs.length > 0) tombstones.push(...(await tx.getAll(...refs)));
      }
      const eligible = memories.filter(
        (memory, index) => !tombstones[index]?.exists && !ownerFamilySourceIsRejected(memory),
      );
      const owner = contacts.find((contact) => contact.trust === 'owner');
      const ownerFacts = owner
        ? eligible
            .filter((row) => row.subjectContactId === owner.id && row.category === 'knowledge')
            .sort(
              (a, b) => b.importance - a.importance || Number(b.confidence) - Number(a.confidence),
            )
            .map(fact)
        : [];
      const people = contacts
        .filter((contact) => contact.trust !== 'owner')
        .map((contact) => {
          const related = eligible.filter((row) => row.subjectContactId === contact.id);
          const pinnedFacts = related
            .filter((row) => row.pinned && row.category === 'knowledge')
            .sort(
              (a, b) => b.importance - a.importance || Number(b.confidence) - Number(a.confidence),
            )
            .map((row) => row.content);
          return {
            id: contact.id,
            name: contact.name,
            relationship: contact.relationship,
            factCount: related.length,
            pinnedFacts,
          };
        })
        .filter((person) => person.factCount > 0)
        .sort((a, b) => b.factCount - a.factCount);
      const content = input.render({ ownerFacts, people });
      tx.set(cardRef, encodeRecord({ agentId: input.agentId, content, compiledAt: input.now }));
      return content;
    });
  }
}
