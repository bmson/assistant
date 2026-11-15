import { readBoundedJson } from '@assistant/application/http-body';
import type {
  EstimatedCostActor,
  EstimatedCostApprovalService,
  EstimatedCostDecision,
  EstimatedCostHttpError,
} from '@assistant/persistence';

type Dependencies = {
  authenticate: (request: Request) => Promise<boolean>;
  checkOrigin: (request: Request) => boolean;
  actor: () => Promise<EstimatedCostActor>;
  service: () => EstimatedCostApprovalService;
};

const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const response = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const error = (
  outcome: EstimatedCostHttpError['outcome'],
  message: string,
  status: number,
  identity: { operationId?: string; decisionId?: string } = {},
) => response({ ok: false, outcome, message, ...identity }, status);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
  );
const statuses = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
  unconfirmed: 503,
} as const;

/** One handler shared by the owner web and authenticated mobile routes. */
export async function handleEstimatedCostHttp(
  request: Request,
  kind: 'quote' | 'decision',
  dependencies: Dependencies,
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'POST') return error('invalid', 'Method not allowed.', 405);
  if (method === 'POST' && !dependencies.checkOrigin(request))
    return error('forbidden', 'Forbidden.', 403);
  try {
    if (!(await dependencies.authenticate(request)))
      return error('unauthorized', 'Authentication required.', 401);
  } catch {
    return error('unavailable', 'Authentication is unavailable.', 503);
  }
  let operationId: string | undefined;
  let decisionId: string | undefined;
  let body: Record<string, unknown> | undefined;
  if (method === 'GET') {
    const params = new URL(request.url).searchParams;
    const keys = kind === 'quote' ? ['operationId'] : ['operationId', 'decisionId'];
    if (
      [...params.keys()].some((key) => !keys.includes(key)) ||
      keys.some((key) => params.getAll(key).length !== 1) ||
      !id(params.get('operationId')) ||
      (kind === 'decision' && !id(params.get('decisionId')))
    )
      return error('invalid', 'Invalid request identity.', 400);
    operationId = params.get('operationId') as string;
    decisionId = params.get('decisionId') ?? undefined;
  } else {
    if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') ?? ''))
      return error('invalid', 'Content type must be application/json.', 400);
    const parsed = await readBoundedJson(request, 4096, 5000);
    if (!parsed.ok) return error('invalid', parsed.error, parsed.status);
    const keys =
      kind === 'quote'
        ? ['operationId', 'quoteRequestId']
        : ['operationId', 'quoteId', 'quoteVersion', 'decisionId', 'decision'];
    if (
      !exact(parsed.value, keys) ||
      !id(parsed.value.operationId) ||
      (kind === 'quote'
        ? !id(parsed.value.quoteRequestId)
        : !id(parsed.value.quoteId) ||
          !id(parsed.value.quoteVersion) ||
          !id(parsed.value.decisionId) ||
          !['approve', 'decline'].includes(String(parsed.value.decision)))
    )
      return error('invalid', 'Invalid request body.', 400);
    body = parsed.value;
    operationId = body.operationId as string;
    decisionId = kind === 'decision' ? (body.decisionId as string) : undefined;
  }
  try {
    const actor = await dependencies.actor();
    const service = dependencies.service();
    const result =
      kind === 'quote'
        ? method === 'GET'
          ? await service.getQuote(actor, operationId)
          : await service.requestQuote(actor, {
              operationId,
              quoteRequestId: body?.quoteRequestId as string,
            })
        : method === 'GET'
          ? await service.getDecisionReceipt(actor, {
              operationId,
              decisionId: decisionId as string,
            })
          : await service.decide(actor, body as unknown as EstimatedCostDecision);
    const status = result.ok
      ? 'receipt' in result && result.receipt.status === 'stale'
        ? 409
        : 200
      : statuses[result.outcome];
    return response(result, status);
  } catch {
    return error(
      method === 'POST' && kind === 'decision' ? 'unconfirmed' : 'unavailable',
      'The request could not be confirmed.',
      503,
      { operationId, ...(decisionId ? { decisionId } : {}) },
    );
  }
}
