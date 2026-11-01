import { ExactTimestamp, isValidExactTimestamp, parseExactTimestamp } from '@assistant/persistence';
import { type SQLWrapper, sql } from 'drizzle-orm';

/** Scoped driver/JSON encoding for exact owner-call instants; ordinary Date stays millisecond-exact. */
class PostgresOwnerCallTimestamp extends ExactTimestamp {
  override toISOString(): string {
    if (!isValidExactTimestamp(this) || this.nanoseconds % 1000 !== 0)
      throw new Error('Invalid PostgreSQL owner-call timestamp');
    const second = new Date(Number(this.seconds * 1000n)).toISOString().slice(0, 19);
    return `${second}.${String(this.nanoseconds / 1000).padStart(6, '0')}Z`;
  }
}

/** A raw Date has already lost any finer precision: retain only the milliseconds it actually has. */
export function decodePostgresOwnerCallTimestamp(value: unknown): Date | null {
  if (value instanceof Date) {
    if (!isValidExactTimestamp(value)) return null;
    if (!(value instanceof ExactTimestamp)) return value;
    return value.nanoseconds % 1000 === 0
      ? new PostgresOwnerCallTimestamp(value.seconds, value.nanoseconds)
      : null;
  }
  if (typeof value !== 'string') return null;
  try {
    const instant = parseExactTimestamp(value);
    if (instant.nanoseconds % 1000 !== 0) return null;
    return new PostgresOwnerCallTimestamp(BigInt(instant.seconds), instant.nanoseconds);
  } catch {
    return null;
  }
}

/** Text projection runs before postgres-js timestamp decoding; no driver-wide changes. */
export function postgresOwnerCallTimestamp(column: SQLWrapper) {
  return sql<Date | null>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.mapWith(
    (raw: unknown) => {
      // SQL NULL represents nullable phase fields or an absent joined receipt.
      // Required-field nulls are rejected by the existing strict domain parser.
      if (raw === null) return null;
      // Invalid non-null storage values must remain invalid, rather than becoming
      // a valid nullable phase field; strict parsers then return unavailable.
      return decodePostgresOwnerCallTimestamp(raw) ?? new Date(Number.NaN);
    },
  );
}

export const postgresOwnerCallClock = sql`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as now`;
