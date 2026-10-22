import { phoneCalendarSnapshotSchema } from '@assistant/persistence';
import { z } from 'zod';
import { getPhoneCalendarPorts } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';
const id = z.string().min(1).max(100);
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sharedCalendar = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().max(300),
    purpose: z.enum(['unspecified', 'commitments', 'reference']),
    timeZone: z.string().max(100).optional(),
  })
  .strict();
const selection = z
  .object({
    ownerId: id,
    command: z.enum(['enable', 'replace', 'select']),
    publisherId: id,
    expectedGeneration: generation,
    mutationId: id,
    consentVersion: z.literal(1),
    calendars: z.array(sharedCalendar).max(100),
  })
  .strict();
const upload = z
  .object({ ownerId: id, publisherId: id, generation, snapshot: phoneCalendarSnapshotSchema })
  .strict();
const revocation = z
  .object({ ownerId: id, publisherId: id, generation, cancelPendingMutationId: id.optional() })
  .strict();

async function input(request: Request): Promise<{ body?: unknown; error?: Response }> {
  const text = await request.text();
  if (Buffer.byteLength(text) > 800_000)
    return { error: mobileJson({ error: 'Calendar payload too large' }, { status: 413 }) };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: mobileJson({ error: 'Invalid calendar request' }, { status: 400 }) };
  }
}
const unavailable = () =>
  mobileJson({ error: 'Calendar sharing is not available on this server' }, { status: 503 });
const wrongOwner = () =>
  mobileJson({ error: 'Calendar sharing belongs to a different workspace' }, { status: 403 });

export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const ports = await getPhoneCalendarPorts();
  if (!ports.cache.phoneCalendarSharing) return unavailable();
  const state = await ports.cache.phoneCalendarSharing.get(ports.agentId);
  return mobileJson({
    ownerId: ports.agentId,
    ownerEmail: ports.ownerEmail,
    timeZone: ports.timeZone,
    state,
  });
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const value = await input(request);
  if (value.error) return value.error;
  const parsed = selection.safeParse(value.body);
  if (!parsed.success)
    return mobileJson({ error: 'Invalid calendar sharing selection' }, { status: 400 });
  const ports = await getPhoneCalendarPorts();
  if (parsed.data.ownerId !== ports.agentId) return wrongOwner();
  if (!ports.cache.phoneCalendarSharing) return unavailable();
  const { ownerId: _ownerId, ...command } = parsed.data;
  const result = await ports.cache.phoneCalendarSharing.apply(ports.agentId, command);
  return mobileJson(result, { status: result.ok ? 200 : 409 });
}

export async function PUT(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const value = await input(request);
  if (value.error) return value.error;
  const parsed = upload.safeParse(value.body);
  if (!parsed.success) return mobileJson({ error: 'Invalid calendar snapshot' }, { status: 400 });
  const ports = await getPhoneCalendarPorts();
  if (parsed.data.ownerId !== ports.agentId) return wrongOwner();
  if (!ports.cache.phoneCalendarSharing) return unavailable();
  if (parsed.data.snapshot.timeZone !== ports.timeZone)
    return mobileJson(
      { error: 'Calendar snapshot time zone does not match the owner time zone' },
      { status: 400 },
    );
  const result = await ports.cache.phoneCalendarSharing.apply(ports.agentId, {
    command: 'snapshot',
    publisherId: parsed.data.publisherId,
    expectedGeneration: parsed.data.generation,
    snapshot: parsed.data.snapshot,
  });
  return mobileJson(result, { status: result.ok ? 200 : 409 });
}

export async function DELETE(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const value = await input(request);
  if (value.error) return value.error;
  const parsed = revocation.safeParse(value.body);
  if (!parsed.success) return mobileJson({ error: 'Invalid calendar revocation' }, { status: 400 });
  const ports = await getPhoneCalendarPorts();
  if (parsed.data.ownerId !== ports.agentId) return wrongOwner();
  if (!ports.cache.phoneCalendarSharing) return unavailable();
  const result = await ports.cache.phoneCalendarSharing.apply(ports.agentId, {
    command: 'revoke',
    publisherId: parsed.data.publisherId,
    expectedGeneration: parsed.data.generation,
    ...(parsed.data.cancelPendingMutationId
      ? { cancelPendingMutationId: parsed.data.cancelPendingMutationId }
      : {}),
  });
  return mobileJson(result, { status: result.ok ? 200 : 409 });
}
