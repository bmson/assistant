/**
 * Source-only codec for the inactive owner family removal operation shape.
 * Importing this module does not enable active admission or persistence.
 */
import {
  type InactiveOwnerFamilyRejectionMarker,
  type InactiveOwnerFamilyRemovalCacheCursor,
  type InactiveOwnerFamilyRemovalRequest,
  inactiveOwnerFamilyRejectionMarkerSchema,
  inactiveOwnerFamilyRemovalCacheCursorSchema,
  inactiveOwnerFamilyRemovalOperationRecordSchema,
  inactiveOwnerFamilyRemovalRequestSchema,
} from './owner-editor-storage-schema.js';

export type {
  InactiveOwnerFamilyRejectionMarker,
  InactiveOwnerFamilyRemovalCacheCursor,
  InactiveOwnerFamilyRemovalRequest,
} from './owner-editor-storage-schema.js';

/** Inactive source contract only; active admission remains unchanged. */
export function parseInactiveOwnerFamilyRemovalOperationRecord(value: unknown) {
  return inactiveOwnerFamilyRemovalOperationRecordSchema.parse(value);
}

export function parseInactiveOwnerFamilyRemovalRequest(
  value: unknown,
): InactiveOwnerFamilyRemovalRequest {
  return inactiveOwnerFamilyRemovalRequestSchema.parse(value);
}

export function parseInactiveOwnerFamilyRemovalCacheCursor(
  value: unknown,
): InactiveOwnerFamilyRemovalCacheCursor {
  return inactiveOwnerFamilyRemovalCacheCursorSchema.parse(value);
}

export function parseInactiveOwnerFamilyRejectionMarker(
  value: unknown,
): InactiveOwnerFamilyRejectionMarker {
  return inactiveOwnerFamilyRejectionMarkerSchema.parse(value);
}
