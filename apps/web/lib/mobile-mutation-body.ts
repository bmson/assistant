import { readBoundedJson } from '@/lib/bounded-json';
import { mobileJson } from '@/mobile-auth';

/** Called after owner authentication, before accessing mutation services. */
export async function readMobileMutationBody(
  request: Request,
  allowedKeys: readonly string[],
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  const body = await readBoundedJson(request);
  if (!body.ok)
    return { ok: false, response: mobileJson({ error: body.error }, { status: body.status }) };
  if (!body.value || typeof body.value !== 'object' || Array.isArray(body.value)) {
    return {
      ok: false,
      response: mobileJson({ error: 'Request body must be an object.' }, { status: 400 }),
    };
  }
  if (Object.keys(body.value).some((key) => !allowedKeys.includes(key))) {
    return {
      ok: false,
      response: mobileJson(
        { error: 'Request body contains an unsupported field.' },
        { status: 400 },
      ),
    };
  }
  return { ok: true, value: body.value as Record<string, unknown> };
}
