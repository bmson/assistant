import type { OwnerEditorOperationRecord, OwnerEditorTerminalResult } from './owner-editor.js';
import {
  ownerEditorEpochCursorSchema,
  ownerEditorOperationRecordSchema,
  ownerEditorTerminalResultSchema,
} from './owner-editor-storage-schema.js';

export function parseOwnerEditorTerminalResult(value: unknown): OwnerEditorTerminalResult {
  return ownerEditorTerminalResultSchema.parse(value);
}
export function parseOwnerEditorOperationRecord(value: unknown): OwnerEditorOperationRecord {
  return ownerEditorOperationRecordSchema.parse(value);
}
export function parseOwnerEditorEpochCursor(value: unknown): {
  ownerId: string;
  epoch: string;
  ready: boolean;
  privacyGenerationDigest: string;
} {
  return ownerEditorEpochCursorSchema.parse(value);
}
