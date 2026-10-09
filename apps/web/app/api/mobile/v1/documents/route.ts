import { uploadDocument } from '@assistant/application/documents';
import { isModuleEnabled, loadConfig, validateAgentPersistenceConfig } from '@assistant/config';
import { readBoundedFormData } from '@/lib/bounded-json';
import { getFirestoreDocumentStores } from '@/lib/firestore-documents';
import { mobilePageMetadata, parseMobileDocumentPageSize } from '@/lib/mobile-document-pages';
import { getApplication, getMobileDocumentsPage, getWorkspace } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_UPLOAD_BYTES + 1024 * 1024;

function hasOnlyBoundedFields(form: FormData, file: File): boolean {
  const allowed = new Set(['file', 'title']);
  for (const key of new Set([...form.keys()])) {
    if (!allowed.has(key) || form.getAll(key).length !== 1) return false;
  }
  const title = form.get('title');
  return (
    form.get('file') === file &&
    (title === null ||
      (typeof title === 'string' && new TextEncoder().encode(title).length <= 1024)) &&
    new TextEncoder().encode(file.name).length <= 255 &&
    file.type.length <= 256
  );
}

/** List the configured owner's documents and aggregate statistics. */
export async function GET(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  if (!isModuleEnabled(loadConfig(), 'documents')) {
    return mobileJson({ error: 'documents module disabled' }, { status: 404 });
  }
  let limit: number;
  try {
    limit = parseMobileDocumentPageSize(new URL(request.url).searchParams.get('limit'));
  } catch {
    return mobileJson({ error: 'Document page size must be between 1 and 100' }, { status: 400 });
  }
  const rawCursor = new URL(request.url).searchParams.get('cursor');
  try {
    const result = await getMobileDocumentsPage({ limit, cursor: rawCursor });
    return mobileJson({
      ...result,
      pagination: mobilePageMetadata({
        limit,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
      }),
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('continuation'))
      return mobileJson({ error: error.message }, { status: 400 });
    return mobileJson(
      { error: 'Documents are unavailable. Retry before viewing them.' },
      { status: 503 },
    );
  }
}

/** Binary document upload with the same limits and extraction pipeline as the web form. */
export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const config = loadConfig();
  if (!isModuleEnabled(config, 'documents')) {
    return mobileJson({ error: 'documents module disabled' }, { status: 404 });
  }
  if (config.PERSISTENCE_DRIVER === 'firestore') {
    const problems = validateAgentPersistenceConfig(config);
    if (problems.length) return mobileJson({ error: problems.join('; ') }, { status: 503 });
  }
  const parsedForm = await readBoundedFormData(request, MAX_MULTIPART_BYTES, 10_000);
  if (!parsedForm.ok) {
    const error =
      parsedForm.status === 413
        ? 'file too large for upload'
        : parsedForm.status === 408
          ? 'upload request body took too long'
          : 'invalid multipart form';
    return mobileJson({ error }, { status: parsedForm.status });
  }
  const form = parsedForm.value;
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
    if (config.PERSISTENCE_DRIVER === 'firestore') {
      const result = await uploadDocument(getFirestoreDocumentStores(), getWorkspace(), {
        name: file.name,
        title: String(form?.get('title') ?? ''),
        mime: file.type,
        bytes: Buffer.from(await file.arrayBuffer()),
      });
      return mobileJson({ ok: true, duplicate: result.duplicate }, { status: 201 });
    }
    await getApplication().uploadDocument({
      name: file.name,
      title: String(form?.get('title') ?? ''),
      mime: file.type,
      bytes: Buffer.from(await file.arrayBuffer()),
    });
    return mobileJson({ ok: true }, { status: 201 });
  } catch (error) {
    return mobileJson(
      { error: error instanceof Error ? error.message : 'Document could not be uploaded.' },
      { status: 409 },
    );
  }
}
