/**
 * Source-only codec for the inactive owner family removal operation shape.
 * Importing this module does not enable active admission or persistence.
 */
import { inactiveOwnerFamilyRemovalOperationRecordSchema } from './owner-editor-storage-schema.js';

/** Inactive source contract only; active admission remains unchanged. */
export function parseInactiveOwnerFamilyRemovalOperationRecord(value: unknown) {
  return inactiveOwnerFamilyRemovalOperationRecordSchema.parse(value);
}
