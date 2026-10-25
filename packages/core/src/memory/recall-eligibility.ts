import type { OwnerCommitment, SituationDecisionContext } from '@assistant/persistence';

/**
 * An identity-bearing candidate for the automatic-recall gate. `meaning` must
 * be assembled only from the source type's approved meaning fields. Identity,
 * revision, labels, dates, status and scores never participate in matching.
 */
export interface AutomaticRecallCandidate {
  id: string;
  sourceRevision: string;
  meaning: string;
}

export type AutomaticRecallEligibilityReason =
  | 'eligible'
  | 'owner_opt_out'
  | 'uncertain_polarity'
  | 'no_request_subject'
  | 'no_candidate_subject_match';

export interface AutomaticRecallEligibility {
  reason: AutomaticRecallEligibilityReason;
  /** Matching candidates retain their original identity, revision and order. */
  candidates: AutomaticRecallCandidate[];
  /** The concrete, non-generic current-query phrases that matched. */
  subjectPhrases: string[];
}

const FIXED_GENERIC_TERMS = new Set([
  'about',
  'after',
  'also',
  'are',
  'can',
  'could',
  'did',
  'does',
  'do',
  'from',
  'have',
  'how',
  'into',
  'is',
  'it',
  'that',
  'the',
  'them',
  'then',
  'this',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  'would',
  'your',
  'you',
  'a',
  'an',
  'and',
  'for',
  'i',
  'in',
  'me',
  'my',
  'of',
  'or',
  'please',
  'to',
  'we',
]);

const GENERIC_TASK_TERMS = new Set([
  'answer',
  'checklist',
  'create',
  'find',
  'generate',
  'give',
  'help',
  'instructions',
  'make',
  'minutes',
  'plan',
  'prepare',
  'preparation',
  'steps',
  'summary',
  'summarize',
  'task',
  'check',
  'compare',
  'choose',
  'pick',
  'apply',
  'use',
  'show',
  'search',
  'need',
  'want',
  'look',
  'review',
  'write',
  'tell',
  'get',
  'organize',
  'list',
  'order',
  'ordered',
  'sequence',
  'format',
]);

const GENERIC_TERMS = new Set([...FIXED_GENERIC_TERMS, ...GENERIC_TASK_TERMS]);
const MAX_SUBJECT_PHRASE_TOKENS = 8;
const QUANTITY_UNITS = new Set([
  'item',
  'items',
  'minute',
  'minutes',
  'hour',
  'hours',
  'step',
  'steps',
  'bullet',
  'bullets',
  'word',
  'words',
  'page',
  'pages',
  'paragraph',
  'paragraphs',
  'sentence',
  'sentences',
  'line',
  'lines',
]);
const FORMAT_OUTPUT_TERMS = new Set([
  'checklist',
  'instructions',
  'summary',
  'list',
  'outline',
  'format',
  'ordered',
  'sequence',
  'bullet',
  'bullets',
]);
const FORMAT_MODIFIER_TERMS = new Set(['brief', 'concise', 'short', 'detailed']);
const NUMBER_WORDS = new Set([
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'first',
  'second',
  'third',
]);
const REQUEST_NEED_CUE = new RegExp(
  `\\b(?:${[...GENERIC_TASK_TERMS, 'think', 'recommend', 'suggest', 'opinion'].join('|')})\\b`,
  'iu',
);
// Recognize bounded questions that explicitly ask about the owner's state or
// an owner-authored action. A generic world question alone is not an owner ask.
const EXPLICIT_OWNER_ACTION_QUESTION =
  /^\s*(?:what|which|where|when|who|whose|how)\b[^.!?]{0,64}\b(?:did|do|does|was|were|is|are|have|has|will|would|can|could|should)\s+(?:I|we|my|our)\b|^\s*what\s+(?:happened|occurred)\s+(?:with|to)\s+(?:my|our)\b/iu;
const COPULAR_OWNER_STATE_QUESTION =
  /^\s*what\s+(?:is|was)\s+(?:the\s+)?(?:current\s+)?(?:name|preference|choice)\b[^.!?]{0,64}\b(?:of|for)\b[^.!?]{0,48}\b(?:in|for)\s+(?:my|our)\b/iu;
const DIRECT_RECALL_OPT_OUT =
  /\b(?:don't|do not|never)\s+(?:use|apply|include|consider)\b[^.!?]{0,100}\b(?:earlier|previous|saved|past)\b/i;
const PERSONAL_RECALL_OPT_OUT =
  /\b(?:i|we)\s+(?:don't|do not)\s+want\s+(?:you\s+)?to\s+(?:use|apply|include|consider)\b[^.!?]{0,100}\b(?:earlier|previous|saved|past)\b/i;
// Automatic recall abstains on current negative constraints instead of
// treating a positive historical preference as compatible with them.
const UNCERTAIN_POLARITY = /\b(?:without|excluding|exclude|avoid|avoiding|not|no)\b/i;
const CONTRACTED_NEGATION =
  /\b(?:(?:do|does|did|is|are|was|were|has|have|had|could|would|should|must|need)n['’]t|can't|won't|shan't)\b/i;

function normalizeRecallSurface(value: string): string {
  return value.normalize('NFC').replace(/[’‘]/gu, "'");
}

function hasUncertainPolarity(requestText: string): boolean {
  const normalized = normalizeRecallSurface(requestText);
  return UNCERTAIN_POLARITY.test(normalized) || CONTRACTED_NEGATION.test(normalized);
}

/** Unicode NFC, locale-independent case folding, and punctuation token boundaries. */
export function normalizeRecallTokens(value: string): string[] {
  const normalized = value
    .normalize('NFC')
    .toLowerCase()
    .replace(/[’‘]/gu, "'")
    .replace(/[‐‑‒–—-]/gu, ' ');
  return normalized.match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

/** Approved meaning fields for a persisted owner commitment. */
export function ownerCommitmentRecallMeaning(
  row: Pick<OwnerCommitment, 'kind' | 'title' | 'details' | 'nextAction'>,
): string {
  return [row.kind, row.title, row.details, row.nextAction].filter(Boolean).join(' ');
}

/** Approved meaning fields for a confirmed situation decision. */
export function situationDecisionRecallMeaning(
  row: Pick<SituationDecisionContext, 'option' | 'outcome' | 'reason' | 'scope'>,
): string {
  return [row.option, row.outcome, row.reason, row.scope].join(' ');
}

function hasDirectOptOut(requestText: string): boolean {
  const normalized = normalizeRecallSurface(requestText);
  return DIRECT_RECALL_OPT_OUT.test(normalized) || PERSONAL_RECALL_OPT_OUT.test(normalized);
}

function querySubjectPhrases(requestText: string): string[] {
  const ownerInformationQuestion =
    /^\s*(?:what|which|where|when|who|whose|how)\b/iu.test(requestText) &&
    (EXPLICIT_OWNER_ACTION_QUESTION.test(requestText) ||
      COPULAR_OWNER_STATE_QUESTION.test(requestText));
  if (!REQUEST_NEED_CUE.test(requestText) && !ownerInformationQuestion) return [];
  const raw = requestText.normalize('NFC').toLowerCase().replace(/[’‘]/gu, "'");
  const rawTokens = [...raw.matchAll(/[\p{L}\p{M}\p{N}]+/gu)];
  const hyphenatedComponents = new Set<number>();
  for (let index = 1; index < rawTokens.length; index += 1) {
    const previous = rawTokens[index - 1];
    const current = rawTokens[index];
    if (!previous || !current) continue;
    const previousIndex = previous.index;
    const currentIndex = current.index;
    if (previousIndex === undefined || currentIndex === undefined) continue;
    const between = raw.slice(previousIndex + previous[0].length, currentIndex);
    if (/^[‐‑‒–—-]+$/u.test(between)) {
      hyphenatedComponents.add(index - 1);
      hyphenatedComponents.add(index);
    }
  }
  const tokens = normalizeRecallTokens(requestText);
  const hasFormatOutput = tokens.some((token) => FORMAT_OUTPUT_TERMS.has(token));
  const formatTokens = new Set<number>();
  if (hasFormatOutput) {
    tokens.forEach((token, index) => {
      if (FORMAT_OUTPUT_TERMS.has(token) || FORMAT_MODIFIER_TERMS.has(token)) {
        formatTokens.add(index);
      }
    });
  }
  const formatQuantityTokens = new Set<number>();
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const quantity =
      NUMBER_WORDS.has(tokens[index] ?? '') || /^\d+(?:\.\d+)?$/u.test(tokens[index] ?? '');
    if (!quantity || !QUANTITY_UNITS.has(tokens[index + 1] ?? '')) continue;
    const following = tokens.slice(index + 2, index + 6);
    if (!following.some((token) => FORMAT_OUTPUT_TERMS.has(token))) continue;
    formatQuantityTokens.add(index);
    formatQuantityTokens.add(index + 1);
  }
  const phrases = new Set<string>();
  // Only contiguous query spans count. Removing generic words before building
  // phrases could accidentally join words that were not adjacent in the ask.
  for (let length = 2; length <= Math.min(MAX_SUBJECT_PHRASE_TOKENS, tokens.length); length += 1) {
    for (let start = 0; start + length <= tokens.length; start += 1) {
      const span = tokens.slice(start, start + length);
      if (
        span.some((token, offset) => {
          const index = start + offset;
          const generic = GENERIC_TERMS.has(token) && !hyphenatedComponents.has(index);
          return generic || formatQuantityTokens.has(index) || formatTokens.has(index);
        })
      )
        continue;
      phrases.add(span.join(' '));
    }
  }
  return [...phrases].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function meaningPhrases(meaning: string): Set<string> {
  const tokens = normalizeRecallTokens(meaning);
  const phrases = new Set<string>();
  for (let length = 2; length <= Math.min(MAX_SUBJECT_PHRASE_TOKENS, tokens.length); length += 1) {
    for (let start = 0; start + length <= tokens.length; start += 1) {
      phrases.add(tokens.slice(start, start + length).join(' '));
    }
  }
  return phrases;
}

/**
 * Gate automatic ambient recall, including a trusted verified continuation
 * after the same caller-side hard gates. Explicit reads use their existing
 * tool path. This helper does not rank, cap, merge, or grant authority.
 */
export function eligibleAutomaticRecallCandidates(
  requestText: string,
  candidates: ReadonlyArray<AutomaticRecallCandidate>,
): AutomaticRecallEligibility {
  if (hasDirectOptOut(requestText)) {
    return { reason: 'owner_opt_out', candidates: [], subjectPhrases: [] };
  }
  if (hasUncertainPolarity(requestText)) {
    return { reason: 'uncertain_polarity', candidates: [], subjectPhrases: [] };
  }

  const subjectPhrases = querySubjectPhrases(requestText);
  if (subjectPhrases.length === 0) {
    return { reason: 'no_request_subject', candidates: [], subjectPhrases };
  }

  const eligible = candidates.filter((candidate) => {
    const meaning = meaningPhrases(candidate.meaning);
    return subjectPhrases.some((phrase) => meaning.has(phrase));
  });
  return {
    reason: eligible.length > 0 ? 'eligible' : 'no_candidate_subject_match',
    candidates: eligible,
    subjectPhrases,
  };
}
