import { readBoundedJson } from '@assistant/application/http-body';
import { CardFormSubmissionSchema } from '@assistant/persistence/card-form';
import { getChatApplication } from '@/lib/server';
import { isMobileAuthed, mobileJson, mobileUnauthorized } from '@/mobile-auth';

export const dynamic = 'force-dynamic';
const MAX_FORM_REQUEST_BYTES = 16 * 1024;
const MAX_FORM_REQUEST_MS = 10_000;

/** A form is admitted only through an authenticated, bounded owner request. */
export async function POST(request: Request): Promise<Response> {
  if (!(await isMobileAuthed(request))) return mobileUnauthorized();
  const body = await readBoundedJson(request, MAX_FORM_REQUEST_BYTES, MAX_FORM_REQUEST_MS);
  if (!body.ok) return mobileJson({ error: body.error }, { status: body.status });
  const parsed = CardFormSubmissionSchema.safeParse(body.value);
  if (!parsed.success) {
    return mobileJson(
      {
        ok: false,
        status: 422,
        error: 'This form could not be submitted. Review its fields and try again.',
      },
      { status: 422 },
    );
  }

  try {
    const result = await getChatApplication().submitCardForm(parsed.data);
    return mobileJson(result, { status: result.ok ? (result.created ? 202 : 200) : result.status });
  } catch {
    // A transport failure here may follow a committed admission. The client
    // retains and replays the same operation/body; do not claim rejection.
    return mobileJson(
      { error: 'The form result could not be confirmed. Retry the same submission.' },
      { status: 503 },
    );
  }
}
