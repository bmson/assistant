import {
  DEFAULT_MAX_BODY_DURATION_MS,
  DEFAULT_MAX_MULTIPART_BODY_BYTES,
  readBoundedFormData,
} from '@assistant/application/http-body';
import { readMobileMutationBody } from '@/lib/mobile-mutation-body';
import { getImportCommands } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function hasOnlyBoundedFields(form: FormData, file: File): boolean {
  const allowed = new Set(['file', 'source', 'voice', 'register']);
  for (const key of new Set([...form.keys()])) {
    if (!allowed.has(key) || form.getAll(key).length !== 1) return false;
  }
  const source = form.get('source');
  const voice = form.get('voice');
  const register = form.get('register');
  return (
    form.get('file') === file &&
    (source === null ||
      (typeof source === 'string' && new TextEncoder().encode(source).length <= 512)) &&
    (voice === null || (typeof voice === 'string' && voice.length <= 1)) &&
    (register === null || (typeof register === 'string' && register.length <= 64)) &&
    new TextEncoder().encode(file.name).length <= 255 &&
    file.type.length <= 256
  );
}

/** Upload a backstory archive or writing samples through the same importer as the web UI. */
export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  if (request.headers.get('content-type')?.includes('application/json')) {
    const mutationBody = await readMobileMutationBody(request, [
      'action',
      'source',
      'verdict',
      'workspacePath',
    ]);
    if (!mutationBody.ok) return mutationBody.response;
    const body = mutationBody.value as {
      action?: unknown;
      source?: unknown;
      verdict?: unknown;
      workspacePath?: unknown;
    } | null;
    if (typeof body?.source !== 'string' || !body.source.trim()) {
      return mobileJson({ error: 'source is required' }, { status: 400 });
    }
    try {
      if (body.action === 'start') {
        if (typeof body.workspacePath !== 'string') {
          return mobileJson({ error: 'workspacePath is required' }, { status: 400 });
        }
        const result = await getImportCommands().startImport(body.workspacePath, body.source);
        if (result.error) return mobileJson({ error: result.error }, { status: 409 });
      } else if (body.action === 'purge') await getImportCommands().purgeImport(body.source);
      else if (body.action === 'delete') await getImportCommands().deleteImport(body.source);
      else if (body.action === 'review') {
        if (body.verdict !== 'approve' && body.verdict !== 'reject') {
          return mobileJson({ error: 'verdict must be approve or reject' }, { status: 400 });
        }
        await getImportCommands().reviewImport(body.source, body.verdict);
      } else {
        return mobileJson(
          { error: 'action must be start, purge, delete, or review' },
          { status: 400 },
        );
      }
      return mobileJson({ ok: true });
    } catch (error) {
      return mobileJson(
        { error: error instanceof Error ? error.message : 'Import could not be updated.' },
        { status: 409 },
      );
    }
  }
  const bounded = await readBoundedFormData(
    request,
    DEFAULT_MAX_MULTIPART_BODY_BYTES,
    DEFAULT_MAX_BODY_DURATION_MS,
  );
  if (!bounded.ok) {
    const error =
      bounded.status === 413
        ? 'file too large for upload'
        : bounded.status === 408
          ? 'upload request body took too long'
          : 'invalid multipart form';
    return mobileJson({ error }, { status: bounded.status });
  }
  const form = bounded.value;
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return mobileJson({ error: 'no file uploaded' }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return mobileJson({ error: 'file too large for upload' }, { status: 413 });
  }
  if (!hasOnlyBoundedFields(form, file)) {
    return mobileJson({ error: 'invalid multipart form fields' }, { status: 400 });
  }
  try {
    const result = await getImportCommands().uploadImport({
      fileName: file.name,
      content: await file.text(),
      source: String(form?.get('source') ?? '').trim(),
      voice: String(form?.get('voice') ?? '') === '1',
      register: String(form?.get('register') ?? ''),
    });
    return mobileJson({ ok: true, destination: result.destination }, { status: 201 });
  } catch (error) {
    return mobileJson(
      { error: error instanceof Error ? error.message : 'Import could not be uploaded.' },
      { status: 409 },
    );
  }
}
