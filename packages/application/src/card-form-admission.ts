import {
  containsCardSecret,
  isSensitiveCardFact,
  publicCardText,
} from '@assistant/core/card-privacy';
import { GenerativeCardSpecV1Schema } from '@assistant/core/generative-card';
import { getQueueNotifier } from '@assistant/core/queue';
import type {
  CardForm,
  CardFormAdmissionPrepared,
  CardFormAdmissionRepository,
  CardFormSubmission,
  CardFormValues,
} from '@assistant/persistence';
import { canonicalCardFormValues, findCardForm } from '@assistant/persistence/card-form';

/** Validate the persisted form and safety of owner text without rewriting it. */
export function prepareOwnerCardFormTurn(input: {
  revisionSpec: unknown;
  form: CardForm;
  values: CardFormValues;
  ownerMessageText: string;
}): CardFormAdmissionPrepared | null {
  const spec = GenerativeCardSpecV1Schema.safeParse(input.revisionSpec);
  if (!spec.success) return null;
  const persistedForm = findCardForm(spec.data, input.form.id);
  if (!persistedForm || JSON.stringify(persistedForm) !== JSON.stringify(input.form)) return null;
  const values = canonicalCardFormValues(persistedForm, input.values);
  if (!values) return null;

  const facts = new Map(spec.data.facts.map((fact) => [fact.id, fact]));
  const secrets = spec.data.facts
    .filter(isSensitiveCardFact)
    .map((fact) => fact.value)
    .filter(Boolean);
  for (const factId of persistedForm.warningFactIds) {
    const fact = facts.get(factId);
    if (!fact || isSensitiveCardFact(fact)) return null;
  }
  for (const field of persistedForm.fields) {
    if (field.sensitive) return null;
    if (field.defaultFact) {
      const fact = facts.get(field.defaultFact);
      if (!fact || isSensitiveCardFact(fact)) return null;
    }
    if (
      field.type === 'choice' &&
      field.options.some(
        (option) =>
          publicCardText(option.label, secrets) !== option.label ||
          containsCardSecret(option.label),
      )
    )
      return null;
    if (field.type !== 'choice') {
      const value = values[field.id];
      if (
        typeof value === 'string' &&
        (containsCardSecret(value) || secrets.some((secret) => value.includes(secret)))
      )
        return null;
    }
    if (publicCardText(field.label, secrets) !== field.label || containsCardSecret(field.label))
      return null;
  }
  for (const label of [persistedForm.title, persistedForm.submitLabel]) {
    if (publicCardText(label, secrets) !== label || containsCardSecret(label)) return null;
  }

  const ownerMessageText = input.ownerMessageText.trim();
  if (
    !ownerMessageText ||
    ownerMessageText.length > 4000 ||
    publicCardText(ownerMessageText, secrets) !== ownerMessageText ||
    containsCardSecret(ownerMessageText) ||
    secrets.some((secret) => ownerMessageText.includes(secret))
  )
    return null;
  return { ownerMessageText };
}

/** Called only by an authenticated owner-Send path; admission itself does no model work. */
export function createCardFormAdmissionService(repository: CardFormAdmissionRepository) {
  return {
    async submit(input: { agentId: string; submission: CardFormSubmission }) {
      const result = await repository.submit({ ...input, prepare: prepareOwnerCardFormTurn });
      if (result.ok && result.created && result.dispatch === 'notify')
        getQueueNotifier().notify(result.taskId, result.queueGeneration);
      return result;
    },
  };
}
