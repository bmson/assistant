import { OWNER_EDITOR_COMMANDS } from '@assistant/persistence/owner-editor';
import { describe, expect, it } from 'vitest';
import {
  BASIC_OWNER_EDITOR_COMMANDS,
  isBasicOwnerEditorCommand,
} from './owner-editor-release-policy';

describe('basic owner-editor release policy', () => {
  it('allows exactly the five reviewed basic editing commands', () => {
    expect(BASIC_OWNER_EDITOR_COMMANDS).toEqual([
      'create_person',
      'update_person_identity',
      'add_family_relationship',
      'correct_owner_family_relationship',
      'correct_owner_memory',
    ]);
    for (const command of BASIC_OWNER_EDITOR_COMMANDS)
      expect(isBasicOwnerEditorCommand(command)).toBe(true);
    for (const command of OWNER_EDITOR_COMMANDS) {
      expect(isBasicOwnerEditorCommand(command)).toBe(
        (BASIC_OWNER_EDITOR_COMMANDS as readonly string[]).includes(command),
      );
    }
  });

  it.each([
    'remove_person',
    'remove_owner_family_relationship',
    'unknown_command',
    '',
    null,
    undefined,
    1,
    {},
  ])('rejects unsupported command values (%s)', (value) => {
    expect(isBasicOwnerEditorCommand(value)).toBe(false);
  });

  it('keeps the shared release allowlist immutable', () => {
    expect(Object.isFrozen(BASIC_OWNER_EDITOR_COMMANDS)).toBe(true);
  });
});
