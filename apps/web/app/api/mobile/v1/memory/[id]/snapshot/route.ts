import { loadOwnerMemorySnapshot } from '@/lib/server';
import {
  authenticateMobileBearer,
  mobileJson,
  mobileUnauthorized,
  resolveMobileOwner,
} from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const READ_ONLY_REASONS = new Set([
  'invalid_owner_or_identity',
  'malformed_owner_correction',
  'unsupported_memory_category',
  'expired_or_invalid_lifecycle',
  'superseded',
  'quarantined',
  'tombstoned',
  'incomplete_provenance',
  'shared_source',
  'conflicting_lineage',
  'unverified_subject',
  'source_identity_mismatch',
  'unverified_extraction_source',
  'unsupported_import_provenance',
  'unknown_provenance',
  'memory_content_hash_mismatch',
]);

function stableReadOnlyReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  return READ_ONLY_REASONS.has(reason) ? reason : 'unverified_source';
}

/** Read one exact owner-scoped saved note without issuing any editing authority. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let principal: Awaited<ReturnType<typeof authenticateMobileBearer>>;
  try {
    principal = await authenticateMobileBearer(request);
  } catch {
    return mobileJson({ code: 'memory_unavailable' }, { status: 503 });
  }
  if (!principal) return mobileUnauthorized();

  const { id } = await params;
  if (!UUID.test(id)) return mobileJson({ error: 'invalid memory id' }, { status: 400 });

  const owner = await resolveMobileOwner(principal);
  if (!owner.ok) return mobileJson({ code: 'memory_unavailable' }, { status: 503 });

  try {
    const snapshot = await loadOwnerMemorySnapshot(owner.ownerId, id);
    if (!snapshot) return mobileJson({ error: 'not_found' }, { status: 404 });
    return mobileJson({
      memoryId: snapshot.memoryId,
      content: snapshot.content,
      // This is the reader's stored hash claim, not a hash of returned content.
      // A malformed stored value is represented as absent; a valid but stale
      // value remains visible beside the reader's mismatch eligibility reason.
      contentHash: SHA256.test(snapshot.contentHash) ? snapshot.contentHash : null,
      revision: snapshot.revision,
      sourceLabel: snapshot.sourceLabel,
      eligible: snapshot.eligible,
      ...(!snapshot.eligible
        ? { readOnlyReason: stableReadOnlyReason(snapshot.readOnlyReason) ?? 'unverified_source' }
        : {}),
      ownerCorrected: snapshot.ownerCorrection !== null,
    });
  } catch {
    return mobileJson({ code: 'memory_unavailable' }, { status: 503 });
  }
}
