import { createHash } from 'node:crypto';
import type { OwnerEditorApply } from '@assistant/persistence';
import { ownerEditorCanonicalApply } from './owner-editor-canonical.js';
/** Server-only: a validated apply body, never session/header/proof input. */
export function ownerEditorRequestHash(request: OwnerEditorApply): string {
  return createHash('sha256').update(ownerEditorCanonicalApply(request)).digest('hex');
}
