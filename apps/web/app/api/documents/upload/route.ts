import { uploadDocument } from '@assistant/application/documents';
import {
  DEFAULT_MAX_BODY_DURATION_MS,
  DEFAULT_MAX_MULTIPART_BODY_BYTES,
  readBoundedFormData,
} from '@assistant/application/http-body';
import { isModuleEnabled, loadConfig } from '@assistant/config';
import { redirect } from 'next/navigation';
import { isAuthed } from '@/auth';
import { getFirestoreDocumentStores } from '@/lib/firestore-documents';
import { getApplication, getWorkspace } from '@/lib/server';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // Cloud Run request cap is 32MB — stay under it

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

/**
 * Document upload (Phase 11): multipart form → binary workspace write → a
 * `documents` row plus a resumable extraction job. Unlike the backstory import
 * route this reads the raw bytes (PDFs, not just UTF-8 archives).
 */
export async function POST(req: Request) {
  if (!isModuleEnabled(loadConfig(), 'documents')) {
    return Response.json({ error: 'documents module disabled' }, { status: 404 });
  }
  if (!(await isAuthed())) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const bounded = await readBoundedFormData(
    req,
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
    return Response.json({ error }, { status: bounded.status });
  }
  const form = bounded.value;
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return Response.json({ error: 'no file uploaded' }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json({ error: 'file too large for upload' }, { status: 413 });
  }
  if (!hasOnlyBoundedFields(form, file)) {
    return Response.json({ error: 'invalid multipart form fields' }, { status: 400 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const input = { name: file.name, title: String(form.get('title') ?? ''), mime: file.type, bytes };
  if (loadConfig().PERSISTENCE_DRIVER === 'firestore')
    await uploadDocument(getFirestoreDocumentStores(), getWorkspace(), input);
  else await getApplication().uploadDocument(input);

  redirect('/documents');
}
