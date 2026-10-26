import { describe, expect, it } from 'vitest';
import {
  ownerEditorEpochStateDigest,
  ownerEditorMaintenanceTargetEpochDigest,
} from './owner-editor-identity.js';
import {
  ownerEditorEpochCursorWithoutMaintenanceBinder,
  parseOwnerEditorEpochCursor,
} from './owner-editor-storage.js';

const ownerId = '11111111-1111-4111-8111-111111111111';
const epoch = '22222222-2222-4222-8222-222222222222';
const binder = {
  version: 1,
  operationId: '33333333-3333-4333-8333-333333333333',
  requestDigest: 'a'.repeat(64),
  action: 'provision-disabled',
  targetEpochDigest: ownerEditorMaintenanceTargetEpochDigest(epoch),
} as const;
const legacy = {
  ownerId,
  epoch,
  ready: false,
  privacyGenerationDigest: 'c'.repeat(64),
};

describe('owner editor epoch cursor codec', () => {
  it('preserves strict legacy four-field cursor compatibility and validates an optional binder', () => {
    expect(parseOwnerEditorEpochCursor(legacy)).toEqual(legacy);
    expect(parseOwnerEditorEpochCursor({ ...legacy, maintenanceBinder: binder })).toEqual({
      ...legacy,
      maintenanceBinder: binder,
    });
    for (const action of ['enable', 'disable'] as const) {
      const cursor = {
        ...legacy,
        ready: action === 'enable',
        maintenanceBinder: { ...binder, action },
      };
      expect(parseOwnerEditorEpochCursor(cursor)).toEqual(cursor);
    }
    for (const invalid of [
      { ...legacy, unknown: true },
      { ...legacy, ready: true, maintenanceBinder: binder },
      { ...legacy, maintenanceBinder: { ...binder, action: 'enable' } },
      { ...legacy, maintenanceBinder: { ...binder, targetEpochDigest: 'b'.repeat(64) } },
      { ...legacy, epoch: '44444444-4444-4444-8444-444444444444', maintenanceBinder: binder },
      { ...legacy, maintenanceBinder: { ...binder, action: 'rotate' } },
      { ...legacy, maintenanceBinder: { ...binder, operationId: 'not-a-uuid' } },
      { ...legacy, maintenanceBinder: { ...binder, requestDigest: 'short' } },
      { ...legacy, maintenanceBinder: { ...binder, targetEpochDigest: 'short' } },
      { ...legacy, maintenanceBinder: { ...binder, extra: true } },
    ])
      expect(() => parseOwnerEditorEpochCursor(invalid)).toThrow();
  });

  it('binds the entire current state and explicitly removes binder on unrelated rotation', () => {
    const parsed = parseOwnerEditorEpochCursor({ ...legacy, maintenanceBinder: binder });
    expect(ownerEditorEpochStateDigest(parsed)).not.toBe(ownerEditorEpochStateDigest(legacy));
    expect(ownerEditorEpochStateDigest(null)).not.toBe(ownerEditorEpochStateDigest(legacy));
    expect(ownerEditorEpochCursorWithoutMaintenanceBinder(parsed)).toEqual(legacy);
  });
});
