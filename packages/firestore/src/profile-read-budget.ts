import { FieldPath, type Query, type QueryDocumentSnapshot } from '@google-cloud/firestore';

// Shared by overlapping reads on one repository instance. Raw snapshots count
// before decoding, including malformed rows. Privacy-fence point reads are separate.
// At most 100 data RPCs and 10,001 raw documents (the last is an EOF probe,
// which must be empty to succeed). No partial totals escape on exhaustion.
export const PROFILE_READ_MAX_DOCUMENTS = 10_000;
export const PROFILE_READ_MAX_REQUESTS = 100;

export class FirestoreProfileReadLimitError extends Error {
  readonly code = 'FIRESTORE_PROFILE_READ_LIMIT';
  constructor() {
    super('Profile data is unavailable because the bounded read limit was reached');
    this.name = 'FirestoreProfileReadLimitError';
  }
}

export class ProfileReadBudget {
  private documents = 0;
  private requests = 0;
  private tail: Promise<unknown> = Promise.resolve();

  // Serialize reservations so concurrent fanout cannot overshoot the shared cap.
  page<T>(size: number, fetch: (limit: number) => Promise<readonly T[]>): Promise<readonly T[]> {
    const read = this.tail.then(async () => {
      if (this.requests >= PROFILE_READ_MAX_REQUESTS) throw new FirestoreProfileReadLimitError();
      const remaining = PROFILE_READ_MAX_DOCUMENTS - this.documents;
      const limit = Math.min(size, Math.max(1, remaining));
      this.requests++;
      const docs = await fetch(limit);
      this.documents += docs.length;
      if (docs.length > limit || this.documents > PROFILE_READ_MAX_DOCUMENTS) {
        throw new FirestoreProfileReadLimitError();
      }
      return docs;
    });
    // A failed read poisons this wave rather than allowing partial sibling results.
    this.tail = read;
    return read;
  }

  records<T>(count: number, fetch: () => Promise<T[]>): Promise<readonly T[]> {
    if (count === 0) return Promise.resolve([]);
    return this.page(count, (limit) => {
      if (limit < count) throw new FirestoreProfileReadLimitError();
      return fetch();
    });
  }
}

export class ProfileReadWave {
  private current: { budget: ProfileReadBudget; readers: number } | undefined;
  async run<T>(read: (budget: ProfileReadBudget) => Promise<T>): Promise<T> {
    const wave = this.current ?? { budget: new ProfileReadBudget(), readers: 0 };
    this.current = wave;
    wave.readers++;
    try {
      return await read(wave.budget);
    } finally {
      if (--wave.readers === 0 && this.current === wave) this.current = undefined;
    }
  }
}

export async function collectProfileDocuments(
  query: Query,
  pageSize: number,
  budget: ProfileReadBudget,
): Promise<QueryDocumentSnapshot[]> {
  const rows: QueryDocumentSnapshot[] = [];
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    let requested = 0;
    const docs = await budget.page(pageSize, async (limit) => {
      requested = limit;
      let pageQuery = query.orderBy(FieldPath.documentId()).limit(limit);
      if (cursor) pageQuery = pageQuery.startAfter(cursor);
      const page = await pageQuery.get();
      if (page.size !== page.docs.length) throw new Error('Invalid profile read page');
      return page.docs;
    });
    let previous = cursor?.id;
    for (const doc of docs) {
      if (previous !== undefined && doc.id <= previous) {
        throw new Error('Profile read cursor did not advance');
      }
      previous = doc.id;
      rows.push(doc);
    }
    if (docs.length < requested) return rows;
    cursor = docs.at(-1);
    if (!cursor) throw new Error('Empty full profile read page');
  }
}
