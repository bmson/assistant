import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

/** Assert both the session fence and database-role permissions before rehearsal startup. */
export async function assertPostgresRestoreRehearsalReadOnly(db: Db): Promise<void> {
  const result = await db.execute(sql`
    SELECT
      current_setting('default_transaction_read_only') = 'on' AS default_read_only,
      current_setting('transaction_read_only') = 'on' AS transaction_read_only,
      COALESCE((
        SELECT rolsuper OR rolcreatedb OR rolcreaterole
        FROM pg_roles WHERE rolname = current_user
      ), true) AS elevated_role,
      has_database_privilege(current_user, current_database(), 'CREATE') OR
        has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_objects,
      EXISTS (
        SELECT 1
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND (
            has_table_privilege(current_user, relation.oid, 'INSERT') OR
            has_table_privilege(current_user, relation.oid, 'UPDATE') OR
            has_table_privilege(current_user, relation.oid, 'DELETE') OR
            has_table_privilege(current_user, relation.oid, 'TRUNCATE')
          )
      ) OR EXISTS (
        SELECT 1
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relkind = 'S'
          AND has_sequence_privilege(current_user, relation.oid, 'USAGE')
      ) AS can_write_public_relation
  `);
  const row = result[0] as
    | {
        default_read_only: boolean;
        transaction_read_only: boolean;
        elevated_role: boolean;
        can_create_objects: boolean;
        can_write_public_relation: boolean;
      }
    | undefined;
  if (
    !row?.default_read_only ||
    !row.transaction_read_only ||
    row.elevated_role ||
    row.can_create_objects ||
    row.can_write_public_relation
  ) {
    throw new Error(
      'Restore rehearsal database session is not enforced read-only; use a non-elevated reader role with no public-table, sequence, or schema write grants',
    );
  }
}
