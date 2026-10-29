import { FieldValue, Timestamp, VectorValue } from '@google-cloud/firestore';
import { documentKey, encodeRecord, type InstallationStore } from './store.js';

type Row = Record<string, unknown>;
/** Offline transactional seam: actual repos/claim helpers, no emulator or services. */
export function ownerEditorTestStore() {
  let values = new Map<string, Row>();
  let version = 1;
  const clock = new Date();
  const times = new Map<string, Timestamp>();
  const stats = {
    requests: 0,
    raw: 0,
    readsAfterWrites: 0,
    unboundedQueries: [] as string[],
    writes: [] as string[],
    failReceipt: false,
    failEpoch: false,
  };
  class Ref {
    readonly id: string;
    readonly path: string;
    constructor(
      readonly table: string,
      readonly logicalId: string,
    ) {
      this.id = documentKey(logicalId);
      this.path = `${table}/${this.id}`;
    }
    async get() {
      return readDoc(this);
    }
  }
  class Doc {
    readonly id: string;
    readonly exists: boolean;
    readonly updateTime?: Timestamp;
    private readonly value?: Row;
    constructor(readonly ref: Ref) {
      this.id = ref.id;
      this.exists = values.has(ref.path);
      this.updateTime = times.get(ref.path);
      this.value = values.get(ref.path);
    }
    data() {
      return this.value;
    }
    get(field: string) {
      return this.value?.[field];
    }
  }
  class Query {
    constructor(
      readonly table: string,
      readonly filters: Array<[string, string, unknown]> = [],
      readonly cap?: number,
    ) {}
    where(field: string, op: string, value: unknown) {
      return new Query(this.table, [...this.filters, [field, op, value]], this.cap);
    }
    limit(cap: number) {
      return new Query(this.table, this.filters, cap);
    }
    orderBy() {
      return this;
    }
    async get() {
      return readQuery(this);
    }
  }
  function readDoc(ref: Ref, charge = true) {
    if (charge) stats.requests++;
    stats.raw++;
    return new Doc(ref);
  }
  function readQuery(query: Query) {
    stats.requests++;
    if (query.cap === undefined) stats.unboundedQueries.push(query.table);
    const docs = [...values.keys()]
      .filter((key) => key.startsWith(`${query.table}/`))
      .sort()
      .flatMap((key) => {
        const value = values.get(key)!;
        if (
          !query.filters.every(([field, op, expected]) =>
            op === 'in'
              ? (expected as unknown[]).includes(value[field])
              : value[field] === expected,
          )
        )
          return [];
        const id = Buffer.from(key.split('/')[1]!, 'base64url').toString('utf8');
        return [new Doc(new Ref(query.table, id))];
      })
      .slice(0, query.cap);
    stats.raw += docs.length;
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
  function sdk(value: unknown): unknown {
    if (value instanceof Date) return Timestamp.fromDate(value);
    if (value instanceof Timestamp || value instanceof FieldValue || value instanceof VectorValue)
      return value;
    if (Array.isArray(value)) return value.map(sdk);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sdk(entry)]));
    return value;
  }
  function seed(table: string, id: string, row: Row) {
    const ref = new Ref(table, id);
    values.set(ref.path, sdk(encodeRecord(row)) as Row);
    times.set(ref.path, new Timestamp(Math.floor(clock.getTime() / 1000), version++));
  }
  const store = {
    now: () => clock,
    doc: (table: string, id: string) => new Ref(table, id),
    collection: (table: string) => new Query(table),
    db: {
      async runTransaction<T>(run: (tx: unknown) => Promise<T>) {
        const staged: Array<{ kind: 'create' | 'set' | 'update' | 'delete'; ref: Ref; row: Row }> =
          [];
        let wrote = false;
        const checkRead = () => {
          if (wrote) {
            stats.readsAfterWrites++;
            throw new Error('Firestore read after first write');
          }
        };
        const tx = {
          async get(ref: Ref | Query) {
            checkRead();
            return ref instanceof Ref ? readDoc(ref) : readQuery(ref);
          },
          async getAll(...refs: Ref[]) {
            checkRead();
            stats.requests++;
            return refs.map((ref) => readDoc(ref, false));
          },
          create(ref: Ref, row: Row) {
            wrote = true;
            staged.push({ kind: 'create', ref, row });
          },
          set(ref: Ref, row: Row) {
            wrote = true;
            if (stats.failEpoch && ref.table === 'maintenanceCursors')
              throw new Error('Injected epoch write failure');
            if (stats.failReceipt && ref.table === 'ownerEditorOperations')
              throw new Error('Injected receipt write failure');
            staged.push({ kind: 'set', ref, row });
          },
          update(ref: Ref, row: Row) {
            wrote = true;
            staged.push({ kind: 'update', ref, row });
          },
          delete(ref: Ref) {
            wrote = true;
            staged.push({ kind: 'delete', ref, row: {} });
          },
        };
        const result = await run(tx);
        const next = new Map(values);
        for (const write of staged) {
          if (write.kind === 'delete') {
            next.delete(write.ref.path);
            continue;
          }
          if (write.kind === 'create' && next.has(write.ref.path))
            throw new Error('Duplicate create');
          if (write.kind === 'update' && !next.has(write.ref.path))
            throw new Error('Missing update');
          next.set(
            write.ref.path,
            sdk(
              write.kind === 'update' ? { ...next.get(write.ref.path), ...write.row } : write.row,
            ) as Row,
          );
        }
        values = next;
        for (const write of staged) {
          if (write.kind === 'delete') times.delete(write.ref.path);
          else
            times.set(write.ref.path, new Timestamp(Math.floor(clock.getTime() / 1000), version++));
          stats.writes.push(write.ref.table);
        }
        return result;
      },
    },
  } as unknown as InstallationStore;
  return {
    store,
    seed,
    stats,
    rows: (table: string) =>
      [...values.entries()].filter(([key]) => key.startsWith(`${table}/`)).map(([, row]) => row),
    remove(table: string, id: string) {
      values.delete(`${table}/${documentKey(id)}`);
    },
  };
}
