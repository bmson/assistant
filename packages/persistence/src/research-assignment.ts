/**
 * Durable state for an owner-authored, research-only assignment.
 * This is deliberately a data contract: creating or reopening it does not
 * enqueue work, create a schedule, notify anyone, or grant outward authority.
 */
export type ResearchAssignmentStatus =
  | 'draft'
  | 'researching'
  | 'waiting_for_decision'
  | 'blocked'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'needs_recheck'
  | 'unknown';

export interface ResearchAssignmentState {
  version: 1;
  assignmentId: string;
  status: ResearchAssignmentStatus;
  stateReason: string | null;
  outcome: string;
  briefRevision: number;
  resultBriefRevision: number | null;
  recipient: { name: string | null; contactId: string | null };
  interests: string[];
  exclusions: string[];
  budget: {
    state: 'known' | 'unknown';
    amount: string | null;
    currency: string | null;
    includesTaxAndDelivery: boolean | null;
  };
  deadline: { state: 'known' | 'unknown'; at: string | null; timeZone: string | null };
  completionCondition: string;
  allowedSources: string[];
  acceptedContext: Array<{
    value: string;
    sourceLabel: string;
    sourceDate: string | null;
    acceptedAt: string;
  }>;
  /** Immutable for this version; no contact, purchase, reservation, or checkout. */
  scope: { kind: 'research_only'; contactAllowed: false; purchaseAllowed: false };
  currentness: 'not_checked' | 'checked_at' | 'stale' | 'unknown';
  lastConfirmedAt: string | null;
  taskId: string | null;
  conversationId: string | null;
  evidence: {
    resultRevision: number | null;
    checkedAt: string | null;
    optionCount: number;
    unverifiedCount: number;
    recommendationId: string | null;
    options: ResearchAssignmentOption[];
  };
  /** Kept as historical evidence after reopen or a material brief edit. */
  completion: { resultRevision: number; acceptedAt: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchAssignmentOption {
  id: string;
  title: string;
  description: string;
  sourceName: string;
  sourceUrl: string | null;
  checkedAt: string;
  itemCost: string | null;
  taxCost: string | null;
  deliveryCost: string | null;
  currency: string | null;
  totalCost: string | null;
  budgetAssessment: 'within_limit' | 'over_limit' | 'unknown';
  availability: 'verified_available' | 'stale' | 'unknown';
  deliveryConfidence: 'verified' | 'unknown';
}

export type ResearchAssignmentOptionInput = Omit<
  ResearchAssignmentOption,
  'checkedAt' | 'totalCost' | 'budgetAssessment' | 'sourceUrl'
> & {
  checkedAt?: never;
  totalCost?: never;
  budgetAssessment?: never;
  sourceUrl?: string | null;
};

export interface ResearchAssignmentOptionsSubmission {
  expectedBriefRevision: number;
  expectedResultRevision: number | null;
  options: ResearchAssignmentOptionInput[];
  recommendationId?: string | null;
}

export function assertResearchAssignmentOptionsInput(
  value: unknown,
): asserts value is ResearchAssignmentOptionsSubmission {
  if (
    !isRecord(value) ||
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== 'string' ||
        ![
          'expectedBriefRevision',
          'expectedResultRevision',
          'options',
          'recommendationId',
        ].includes(key),
    ) ||
    !Number.isSafeInteger(value.expectedBriefRevision) ||
    (value.expectedBriefRevision as number) < 1 ||
    (value.expectedResultRevision !== null &&
      (!Number.isSafeInteger(value.expectedResultRevision) ||
        (value.expectedResultRevision as number) < 1)) ||
    !Array.isArray(value.options) ||
    value.options.length < 1 ||
    value.options.length > 10 ||
    ('recommendationId' in value && !isNullableString(value.recommendationId))
  )
    throw new Error('Research option submission is malformed');
  const valid = value.options.every((option) => {
    if (!isRecord(option)) return false;
    const keys = [
      'id',
      'title',
      'description',
      'sourceName',
      'itemCost',
      'taxCost',
      'deliveryCost',
      'currency',
      'availability',
      'deliveryConfidence',
    ];
    const actual = Reflect.ownKeys(option);
    if (
      actual.some(
        (key) =>
          typeof key !== 'string' ||
          (!keys.includes(key) && key !== 'sourceUrl') ||
          ![...keys, 'sourceUrl'].includes(key),
      ) ||
      keys.some((key) => !(key in option))
    )
      return false;
    if (
      typeof option.id !== 'string' ||
      !option.id.trim() ||
      typeof option.title !== 'string' ||
      !option.title.trim() ||
      typeof option.description !== 'string' ||
      typeof option.sourceName !== 'string' ||
      !option.sourceName.trim() ||
      !['verified_available', 'stale', 'unknown'].includes(String(option.availability)) ||
      !['verified', 'unknown'].includes(String(option.deliveryConfidence)) ||
      ![option.itemCost, option.taxCost, option.deliveryCost].every(
        (cost) => isNullableString(cost) && (cost === null || /^\d+(?:\.\d+)?$/.test(cost)),
      ) ||
      !isNullableString(option.currency) ||
      (option.currency !== null && !/^[A-Z]{3}$/.test(option.currency)) ||
      ('sourceUrl' in option && !isSafeHttpsUrl(option.sourceUrl))
    )
      return false;
    return true;
  });
  if (!valid) throw new Error('Research option details are malformed');
  const ids = value.options.map((option) => (option as UnknownRecord).id);
  if (new Set(ids).size !== ids.length) throw new Error('Research option ids must be unique');
  if (typeof value.recommendationId === 'string' && !ids.includes(value.recommendationId))
    throw new Error('Recommended option must be part of the shortlist');
}

export interface NewResearchAssignmentInput {
  assignmentId: string;
  outcome: string;
  recipientName?: string | null;
  contactId?: string | null;
  interests?: string[];
  exclusions?: string[];
  budget?: ResearchAssignmentState['budget'];
  deadline?: ResearchAssignmentState['deadline'];
  completionCondition: string;
  allowedSources?: string[];
  acceptedContext?: ResearchAssignmentState['acceptedContext'];
  now: Date;
}

export type ResearchAssignmentCreateInput = Omit<
  NewResearchAssignmentInput,
  'assignmentId' | 'now'
>;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isSafeHttpsUrl(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isDecimalOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isAcceptedContextArray(
  value: unknown,
): value is ResearchAssignmentState['acceptedContext'] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        hasExactKeys(item, ['value', 'sourceLabel', 'sourceDate', 'acceptedAt']) &&
        typeof item.value === 'string' &&
        typeof item.sourceLabel === 'string' &&
        isNullableString(item.sourceDate) &&
        isTimestamp(item.acceptedAt),
    )
  );
}

export function assertResearchAssignmentBriefPatch(
  value: unknown,
): asserts value is ResearchAssignmentBriefPatch {
  const allowed = [
    'outcome',
    'recipient',
    'interests',
    'exclusions',
    'budget',
    'deadline',
    'completionCondition',
    'allowedSources',
    'acceptedContext',
  ] as const;
  if (
    !isRecord(value) ||
    Reflect.ownKeys(value).some(
      (key) => typeof key !== 'string' || !allowed.includes(key as (typeof allowed)[number]),
    )
  )
    throw new Error('Assignment patch contains an unsupported field');
  if (
    'outcome' in value &&
    (typeof value.outcome !== 'string' || !value.outcome.trim() || value.outcome.length > 2000)
  )
    throw new Error('Assignment outcome is required');
  if (
    'completionCondition' in value &&
    (typeof value.completionCondition !== 'string' ||
      !value.completionCondition.trim() ||
      value.completionCondition.length > 1000)
  )
    throw new Error('Assignment completion condition is required');
  if ('recipient' in value) {
    const recipient = value.recipient;
    if (
      !isRecord(recipient) ||
      !hasExactKeys(recipient, ['name', 'contactId']) ||
      !isNullableString(recipient.name) ||
      !isNullableString(recipient.contactId)
    )
      throw new Error('Recipient details are malformed');
  }
  if ('interests' in value && !isStringArray(value.interests))
    throw new Error('Interests must be a list of strings');
  if ('exclusions' in value && !isStringArray(value.exclusions))
    throw new Error('Exclusions must be a list of strings');
  if ('allowedSources' in value && !isStringArray(value.allowedSources))
    throw new Error('Allowed sources must be a list of strings');
  if ('acceptedContext' in value && !isAcceptedContextArray(value.acceptedContext))
    throw new Error('Accepted profile context is malformed');
  if ('budget' in value) validateBudget(value.budget);
  if ('deadline' in value) validateDeadline(value.deadline);
}

export function assertResearchAssignmentCreateInput(
  value: unknown,
): asserts value is ResearchAssignmentCreateInput {
  const allowed = [
    'outcome',
    'recipientName',
    'contactId',
    'interests',
    'exclusions',
    'budget',
    'deadline',
    'completionCondition',
    'allowedSources',
    'acceptedContext',
  ];
  if (
    !isRecord(value) ||
    Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.includes(key)) ||
    typeof value.outcome !== 'string' ||
    !value.outcome.trim() ||
    value.outcome.length > 2000 ||
    typeof value.completionCondition !== 'string' ||
    !value.completionCondition.trim() ||
    value.completionCondition.length > 1000
  )
    throw new Error('Assignment outcome and completion condition are required');
  if ('recipientName' in value && !isNullableString(value.recipientName))
    throw new Error('Recipient name must be text or unknown');
  if ('contactId' in value && !isNullableString(value.contactId))
    throw new Error('Recipient reference is malformed');
  if ('interests' in value && !isStringArray(value.interests))
    throw new Error('Interests must be a list of strings');
  if ('exclusions' in value && !isStringArray(value.exclusions))
    throw new Error('Exclusions must be a list of strings');
  if ('allowedSources' in value && !isStringArray(value.allowedSources))
    throw new Error('Allowed sources must be a list of strings');
  if ('acceptedContext' in value && !isAcceptedContextArray(value.acceptedContext))
    throw new Error('Accepted profile context is malformed');
  if ('budget' in value) validateBudget(value.budget);
  if ('deadline' in value) validateDeadline(value.deadline);
}

export function assertResearchAssignmentState(
  value: unknown,
): asserts value is ResearchAssignmentState {
  if (!isRecord(value)) throw new Error('Research assignment record is malformed');
  const row = value;
  const statuses: ResearchAssignmentStatus[] = [
    'draft',
    'researching',
    'waiting_for_decision',
    'blocked',
    'paused',
    'completed',
    'cancelled',
    'needs_recheck',
    'unknown',
  ];
  const recipient = row.recipient;
  const scope = row.scope;
  const evidence = row.evidence;
  const completion = row.completion;
  const contextsValid = isAcceptedContextArray(row.acceptedContext);
  if (
    !hasExactKeys(row, [
      'version',
      'assignmentId',
      'status',
      'stateReason',
      'outcome',
      'briefRevision',
      'resultBriefRevision',
      'recipient',
      'interests',
      'exclusions',
      'budget',
      'deadline',
      'completionCondition',
      'allowedSources',
      'acceptedContext',
      'scope',
      'currentness',
      'lastConfirmedAt',
      'taskId',
      'conversationId',
      'evidence',
      'completion',
      'createdAt',
      'updatedAt',
    ]) ||
    row.version !== 1 ||
    typeof row.assignmentId !== 'string' ||
    !row.assignmentId ||
    !statuses.includes(row.status as ResearchAssignmentStatus) ||
    typeof row.outcome !== 'string' ||
    !row.outcome.trim() ||
    (typeof row.stateReason !== 'string' && row.stateReason !== null) ||
    !Number.isSafeInteger(row.briefRevision) ||
    (row.briefRevision as number) < 1 ||
    (row.resultBriefRevision !== null &&
      (!Number.isSafeInteger(row.resultBriefRevision) ||
        (row.resultBriefRevision as number) < 1 ||
        (row.resultBriefRevision as number) > (row.briefRevision as number))) ||
    !isRecord(recipient) ||
    !hasExactKeys(recipient, ['name', 'contactId']) ||
    !isNullableString(recipient.name) ||
    !isNullableString(recipient.contactId) ||
    !isStringArray(row.interests) ||
    !isStringArray(row.exclusions) ||
    !isStringArray(row.allowedSources) ||
    !contextsValid ||
    typeof row.completionCondition !== 'string' ||
    !row.completionCondition.trim() ||
    !['not_checked', 'checked_at', 'stale', 'unknown'].includes(String(row.currentness)) ||
    !isNullableString(row.lastConfirmedAt) ||
    (row.lastConfirmedAt !== null && !isTimestamp(row.lastConfirmedAt)) ||
    !isNullableString(row.taskId) ||
    !isNullableString(row.conversationId) ||
    (row.taskId === null) !== (row.conversationId === null) ||
    !isTimestamp(row.createdAt) ||
    !isTimestamp(row.updatedAt) ||
    !isRecord(scope) ||
    !hasExactKeys(scope, ['kind', 'contactAllowed', 'purchaseAllowed']) ||
    scope.kind !== 'research_only' ||
    scope.contactAllowed !== false ||
    scope.purchaseAllowed !== false ||
    !isRecord(evidence) ||
    !hasExactKeys(evidence, [
      'resultRevision',
      'checkedAt',
      'optionCount',
      'unverifiedCount',
      'recommendationId',
      'options',
    ]) ||
    (evidence.resultRevision !== null &&
      (!Number.isSafeInteger(evidence.resultRevision) ||
        (evidence.resultRevision as number) < 1)) ||
    !isNullableString(evidence.checkedAt) ||
    (evidence.checkedAt !== null && !isTimestamp(evidence.checkedAt)) ||
    !Number.isSafeInteger(evidence.optionCount) ||
    (evidence.optionCount as number) < 0 ||
    (evidence.optionCount as number) > 10 ||
    !Number.isSafeInteger(evidence.unverifiedCount) ||
    (evidence.unverifiedCount as number) < 0 ||
    (evidence.unverifiedCount as number) > (evidence.optionCount as number) ||
    !isNullableString(evidence.recommendationId) ||
    !Array.isArray(evidence.options) ||
    evidence.options.length !== evidence.optionCount ||
    !evidence.options.every(isResearchAssignmentOption) ||
    (evidence.recommendationId !== null &&
      !evidence.options.some((option) => option.id === evidence.recommendationId)) ||
    !(
      completion === null ||
      (isRecord(completion) &&
        hasExactKeys(completion, ['resultRevision', 'acceptedAt']) &&
        Number.isSafeInteger(completion.resultRevision) &&
        (completion.resultRevision as number) > 0 &&
        isTimestamp(completion.acceptedAt))
    )
  )
    throw new Error('Research assignment record is malformed or unsupported');
  validateBudget(row.budget);
  validateDeadline(row.deadline);
  if (
    (evidence.resultRevision === null) !== (evidence.checkedAt === null) ||
    (evidence.resultRevision === null && row.resultBriefRevision !== null) ||
    (row.resultBriefRevision !== null && row.resultBriefRevision !== row.briefRevision) ||
    (evidence.resultRevision === null && evidence.optionCount !== 0) ||
    (['waiting_for_decision', 'completed'].includes(String(row.status)) &&
      (evidence.resultRevision === null || row.resultBriefRevision !== row.briefRevision)) ||
    (row.status === 'completed' &&
      (!completion || completion.resultRevision !== evidence.resultRevision))
  )
    throw new Error('Research assignment evidence revisions are inconsistent');
}

function isResearchAssignmentOption(value: unknown): value is ResearchAssignmentOption {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, [
      'id',
      'title',
      'description',
      'sourceName',
      'sourceUrl',
      'checkedAt',
      'itemCost',
      'taxCost',
      'deliveryCost',
      'currency',
      'totalCost',
      'budgetAssessment',
      'availability',
      'deliveryConfidence',
    ]) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.title === 'string' &&
    value.title.length > 0 &&
    typeof value.description === 'string' &&
    typeof value.sourceName === 'string' &&
    value.sourceName.length > 0 &&
    isSafeHttpsUrl(value.sourceUrl) &&
    isTimestamp(value.checkedAt) &&
    isDecimalOrNull(value.itemCost) &&
    isDecimalOrNull(value.taxCost) &&
    isDecimalOrNull(value.deliveryCost) &&
    isNullableString(value.currency) &&
    (value.currency === null || /^[A-Z]{3}$/.test(value.currency)) &&
    isDecimalOrNull(value.totalCost) &&
    ['within_limit', 'over_limit', 'unknown'].includes(String(value.budgetAssessment)) &&
    ['verified_available', 'stale', 'unknown'].includes(String(value.availability)) &&
    ['verified', 'unknown'].includes(String(value.deliveryConfidence))
  );
}

function iso(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new Error('Invalid assignment timestamp');
  return value.toISOString();
}

function validateBudget(value: unknown): asserts value is ResearchAssignmentState['budget'] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['state', 'amount', 'currency', 'includesTaxAndDelivery'])
  )
    throw new Error('Budget details are malformed');
  const budget = value;
  if (budget.state === 'unknown') {
    if (
      budget.amount !== null ||
      budget.currency !== null ||
      budget.includesTaxAndDelivery !== null
    )
      throw new Error('Unknown budget cannot contain a partial amount');
    return;
  }
  if (
    budget.state !== 'known' ||
    typeof budget.amount !== 'string' ||
    !/^\d+(?:\.\d+)?$/.test(budget.amount)
  )
    throw new Error('Budget must be a non-negative decimal amount');
  if (typeof budget.currency !== 'string' || !/^[A-Z]{3}$/.test(budget.currency))
    throw new Error('Budget currency must be a three-letter uppercase code');
  let fractionDigits: number;
  try {
    fractionDigits =
      new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: budget.currency,
      }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    throw new Error('Budget currency is unsupported');
  }
  if ((budget.amount.split('.')[1]?.length ?? 0) > fractionDigits)
    throw new Error('Budget amount has too many decimal places for its currency');
  if (budget.includesTaxAndDelivery !== true)
    throw new Error('A known assignment budget must include tax and delivery');
}

function validateDeadline(value: unknown): asserts value is ResearchAssignmentState['deadline'] {
  if (!isRecord(value) || !hasExactKeys(value, ['state', 'at', 'timeZone']))
    throw new Error('Deadline details are malformed');
  const deadline = value;
  if (deadline.state === 'unknown') {
    if (deadline.at !== null || deadline.timeZone !== null)
      throw new Error('Unknown deadline cannot contain a partial timestamp');
    return;
  }
  if (deadline.state !== 'known') throw new Error('Deadline state is unsupported');
  if (
    typeof deadline.at !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(deadline.at) ||
    !Number.isFinite(Date.parse(deadline.at))
  )
    throw new Error('Known deadline requires an ISO timestamp');
  if (typeof deadline.timeZone !== 'string' || !deadline.timeZone)
    throw new Error('Known deadline requires an explicit IANA time zone');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: deadline.timeZone });
  } catch {
    throw new Error('Known deadline requires an explicit IANA time zone');
  }
}

export function createResearchAssignment(
  input: NewResearchAssignmentInput,
): ResearchAssignmentState {
  if (!isRecord(input)) throw new Error('Assignment input is malformed');
  const { assignmentId, now, ...request } = input;
  assertResearchAssignmentCreateInput(request);
  if (typeof assignmentId !== 'string' || !assignmentId.trim() || !(now instanceof Date))
    throw new Error('Assignment id, outcome, and completion condition are required');
  const budget = input.budget ?? {
    state: 'unknown',
    amount: null,
    currency: null,
    includesTaxAndDelivery: null,
  };
  const deadline = input.deadline ?? { state: 'unknown', at: null, timeZone: null };
  validateBudget(budget);
  validateDeadline(deadline);
  const timestamp = iso(input.now);
  return {
    version: 1,
    assignmentId: input.assignmentId,
    status: 'draft',
    stateReason: null,
    outcome: input.outcome.trim(),
    briefRevision: 1,
    resultBriefRevision: null,
    recipient: { name: input.recipientName?.trim() || null, contactId: input.contactId ?? null },
    interests: [...(input.interests ?? [])],
    exclusions: [...(input.exclusions ?? [])],
    budget: { ...budget },
    deadline: { ...deadline },
    completionCondition: input.completionCondition.trim(),
    allowedSources: [...(input.allowedSources ?? [])],
    acceptedContext: [...(input.acceptedContext ?? [])],
    scope: { kind: 'research_only', contactAllowed: false, purchaseAllowed: false },
    currentness: 'not_checked',
    lastConfirmedAt: null,
    taskId: null,
    conversationId: null,
    evidence: {
      resultRevision: null,
      checkedAt: null,
      optionCount: 0,
      unverifiedCount: 0,
      recommendationId: null,
      options: [],
    },
    completion: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export type ResearchAssignmentBriefPatch = Partial<
  Pick<
    ResearchAssignmentState,
    | 'outcome'
    | 'recipient'
    | 'interests'
    | 'exclusions'
    | 'budget'
    | 'deadline'
    | 'completionCondition'
    | 'allowedSources'
    | 'acceptedContext'
  >
>;

/** A material edit increments the brief revision and keeps, but stales, old evidence. */
export function editResearchAssignmentBrief(
  current: ResearchAssignmentState,
  patch: ResearchAssignmentBriefPatch,
  now: Date,
): ResearchAssignmentState {
  assertResearchAssignmentBriefPatch(patch);
  if (current.status === 'cancelled') throw new Error('Cancelled assignments cannot be edited');
  const next = { ...current, ...patch, updatedAt: iso(now) };
  const material = Object.keys(patch).some(
    (key) =>
      JSON.stringify(current[key as keyof ResearchAssignmentState]) !==
      JSON.stringify(next[key as keyof ResearchAssignmentState]),
  );
  if (!material) return current;
  next.briefRevision += 1;
  if (next.evidence.resultRevision !== null) {
    next.currentness = 'stale';
    next.status = 'needs_recheck';
    next.stateReason = 'The brief changed after this research was checked.';
    next.resultBriefRevision = null;
  } else if (next.status === 'completed' || next.status === 'waiting_for_decision') {
    next.status = 'draft';
    next.stateReason = null;
  }
  return next;
}

/** Reopen retains prior evidence and never starts a task or schedule. */
export function reopenResearchAssignment(
  current: ResearchAssignmentState,
  now: Date,
): ResearchAssignmentState {
  if (current.status === 'cancelled') throw new Error('Cancelled assignments cannot be reopened');
  return {
    ...current,
    status: current.evidence.resultRevision === null ? 'draft' : 'needs_recheck',
    stateReason:
      current.evidence.resultRevision === null
        ? null
        : 'Previous research is retained and needs a freshness check.',
    currentness: current.evidence.resultRevision === null ? 'not_checked' : 'stale',
    updatedAt: iso(now),
  };
}

/** Pause or cancel future assignment work without claiming dispatched work stopped. */
export function setResearchAssignmentStoppedState(
  current: ResearchAssignmentState,
  status: 'paused' | 'cancelled',
  now: Date,
): ResearchAssignmentState {
  if (status !== 'paused' && status !== 'cancelled')
    throw new Error('Unsupported assignment stop state');
  if (current.status === 'cancelled') throw new Error('Cancelled assignments cannot change state');
  if (current.status === 'completed') throw new Error('Completed assignments cannot change state');
  return {
    ...current,
    status,
    stateReason:
      status === 'paused'
        ? 'Paused by the owner. Already dispatched work may still be running.'
        : 'Cancelled by the owner. Already dispatched work may still be running.',
    updatedAt: iso(now),
  };
}

function decimalMinorUnits(value: string | null, currency: string): bigint | null {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const fractionDigits =
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).resolvedOptions().maximumFractionDigits ?? 2;
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > fractionDigits) return null;
  return BigInt(`${whole}${fraction.padEnd(fractionDigits, '0')}`);
}

function minorUnitsDecimal(value: bigint, currency: string): string {
  const fractionDigits =
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).resolvedOptions().maximumFractionDigits ?? 2;
  if (fractionDigits === 0) return String(value);
  const factor = 10n ** BigInt(fractionDigits);
  return `${value / factor}.${String(value % factor).padStart(fractionDigits, '0')}`;
}

/** Store checked shortlist evidence; unavailable totals or stale stock stay unverified. */
export function recordResearchAssignmentOptions(
  current: ResearchAssignmentState,
  input: ResearchAssignmentOptionsSubmission,
  now: Date,
): ResearchAssignmentState {
  assertResearchAssignmentOptionsInput(input);
  if (input.expectedBriefRevision !== current.briefRevision)
    throw new Error('Assignment brief changed while research was in progress');
  if (input.expectedResultRevision !== current.evidence.resultRevision)
    throw new Error('Research result changed while this update was in progress');
  if (['cancelled', 'paused', 'completed'].includes(current.status))
    throw new Error('This assignment cannot accept new research results');
  if (!input.options.length || input.options.length > 10)
    throw new Error('Research results must contain between one and ten options');
  const ids = new Set(input.options.map((option) => option.id));
  if (
    ids.size !== input.options.length ||
    input.options.some(
      (option) => !option.id.trim() || !option.title.trim() || !option.sourceName.trim(),
    )
  )
    throw new Error('Each research option needs a unique id, title, and source');
  if (input.recommendationId && !ids.has(input.recommendationId))
    throw new Error('Recommended option must be part of the shortlist');

  const checkedAt = iso(now);
  const options = input.options.map((option): ResearchAssignmentOption => {
    const currency = option.currency?.toUpperCase() ?? null;
    let totalCost: string | null = null;
    let budgetAssessment: ResearchAssignmentOption['budgetAssessment'] = 'unknown';
    if (
      currency &&
      /^[A-Z]{3}$/.test(currency) &&
      option.itemCost !== null &&
      option.taxCost !== null &&
      option.deliveryCost !== null
    ) {
      try {
        const item = decimalMinorUnits(option.itemCost, currency);
        const tax = decimalMinorUnits(option.taxCost, currency);
        const delivery = decimalMinorUnits(option.deliveryCost, currency);
        if (item !== null && tax !== null && delivery !== null) {
          const total = item + tax + delivery;
          totalCost = minorUnitsDecimal(total, currency);
          const cap =
            current.budget.state === 'known' && current.budget.currency === currency
              ? decimalMinorUnits(current.budget.amount, currency)
              : null;
          if (cap !== null) budgetAssessment = total <= cap ? 'within_limit' : 'over_limit';
        }
      } catch {
        // Unsupported currencies or amounts stay unknown.
      }
    }
    const sourceUrl = option.sourceUrl?.trim() || null;
    let safeSourceUrl: string | null = null;
    if (sourceUrl) {
      try {
        const url = new URL(sourceUrl);
        if (url.protocol === 'https:' && !url.username && !url.password)
          safeSourceUrl = url.toString();
      } catch {
        // Keep the source label and omit malformed links.
      }
    }
    if (
      !['verified_available', 'stale', 'unknown'].includes(option.availability) ||
      !['verified', 'unknown'].includes(option.deliveryConfidence)
    )
      throw new Error('Research option confidence is invalid');
    return {
      ...option,
      title: option.title.trim(),
      description: option.description.trim(),
      sourceName: option.sourceName.trim(),
      sourceUrl: safeSourceUrl,
      checkedAt,
      currency,
      totalCost,
      budgetAssessment,
    };
  });
  const unverifiedCount = options.filter(
    (option) =>
      option.availability !== 'verified_available' ||
      option.deliveryConfidence !== 'verified' ||
      option.totalCost === null ||
      option.budgetAssessment === 'unknown',
  ).length;
  const resultRevision = (current.evidence.resultRevision ?? 0) + 1;
  return {
    ...current,
    status: 'waiting_for_decision',
    stateReason: null,
    resultBriefRevision: current.briefRevision,
    currentness: 'checked_at',
    lastConfirmedAt: checkedAt,
    evidence: {
      resultRevision,
      checkedAt,
      optionCount: options.length,
      unverifiedCount,
      recommendationId: input.recommendationId ?? null,
      options,
    },
    updatedAt: checkedAt,
  };
}

/** Explicit owner acceptance of the current brief's shortlist is the only completion event. */
export function acceptResearchShortlist(
  current: ResearchAssignmentState,
  resultRevision: number,
  now: Date,
): ResearchAssignmentState {
  if (!Number.isSafeInteger(resultRevision) || resultRevision < 1)
    throw new Error('Invalid shortlist revision');
  if (current.status !== 'waiting_for_decision')
    throw new Error('Assignment is not waiting for a shortlist decision');
  if (current.resultBriefRevision !== current.briefRevision)
    throw new Error('Shortlist does not match the current brief revision');
  if (current.evidence.resultRevision !== resultRevision)
    throw new Error('Shortlist revision does not match the current evidence');
  return {
    ...current,
    status: 'completed',
    stateReason: null,
    completion: { resultRevision, acceptedAt: iso(now) },
    updatedAt: iso(now),
  };
}
