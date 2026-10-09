import { activeAutonomyGrant } from '@assistant/core/workflow/autonomy';
import {
  decodeDiscoveryCursor,
  discoveryInput,
  encodeDiscoveryCursor,
  matchesTaskDiscovery,
  type TaskDiscoveryInput,
  type TaskDiscoveryRepository,
  type TaskDiscoveryRow,
} from '@assistant/persistence';

const SCAN_LIMIT = 500;
export async function discoverActivityWithRepository(
  repository: TaskDiscoveryRepository,
  agentId: string,
  rawInput: TaskDiscoveryInput,
) {
  const input = discoveryInput(rawInput);
  const page = await repository.scan(agentId, {
    after: decodeDiscoveryCursor(agentId, repository.driver, input),
    limit: SCAN_LIMIT,
  });
  const selected = [];
  let scanned = 0;
  let unknownCreatedTimeRows = 0;
  let last: TaskDiscoveryRow | undefined;
  for (const row of page.rows) {
    scanned += 1;
    last = row;
    if (!row.suppressed && row.status !== '__canary__' && !row.createdAt)
      unknownCreatedTimeRows += 1;
    if (!row.suppressed && row.status !== '__canary__' && matchesTaskDiscovery(row, input))
      selected.push(row);
    if (selected.length >= (input.limit ?? 50)) break;
  }
  const hasMore = scanned < page.rows.length || page.hasMore;
  const pending = new Set(page.pendingApprovalTaskIds);
  return {
    items: selected.map(({ agentId: _owner, suppressed: _suppressed, autonomyGrant, ...row }) => ({
      ...row,
      hasPendingApproval: pending.has(row.id),
      hasActiveAutonomy: activeAutonomyGrant({ ...row, autonomyGrant }, Date.now()) !== null,
      stuckWaiting: row.status === 'waiting_approval' && !pending.has(row.id),
    })),
    archivedCount: page.archivedCount,
    nextCursor:
      hasMore && last
        ? encodeDiscoveryCursor(agentId, repository.driver, input, {
            at: last.updatedAt,
            id: last.id,
          })
        : null,
    scanned,
    scanLimit: SCAN_LIMIT,
    unknownCreatedTimeRows,
    searchIncomplete: hasMore,
    captureStatus:
      'Task identities are recorded; detailed audit sections may be unavailable or redacted. Legacy records without creation times cannot be matched by date filters.',
  };
}
