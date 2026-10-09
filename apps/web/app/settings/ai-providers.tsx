'use client';

import type {
  ModelProviderSettingsView,
  ProviderModelListing,
} from '@assistant/application/model-providers';
import { Check, KeyRound, LoaderCircle, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useMemo, useState, useTransition } from 'react';
import {
  addProviderModelAction,
  addVoicePresetAction,
  chooseTextModelsAction,
  chooseVoiceModelAction,
  removeProviderConnectionAction,
  saveProviderConnectionAction,
  setProviderConnectionEnabledAction,
  testProviderConnectionAction,
} from '@/app/settings/provider-actions';
import { Badge, btn, btnSm, inputClass, labelClass, selectClass } from '@/lib/ui';
import { ConfirmButton } from '@/lib/ui-client';

type Kind = ModelProviderSettingsView['connections'][number]['kind'];

/** Label stacked over its field, so long values never squeeze the caption. */
const field = `${labelClass} flex min-w-0 flex-col gap-1.5`;

const KIND_LABEL: Record<Kind, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  vertex: 'Google Vertex AI',
  openai_compatible: 'OpenAI-compatible',
};

const KEY_HELP: Partial<Record<Kind, { placeholder: string; url: string }>> = {
  openrouter: { placeholder: 'sk-or-…', url: 'https://openrouter.ai/settings/keys' },
  openai: { placeholder: 'sk-…', url: 'https://platform.openai.com/api-keys' },
};

const PRICING_URL: Partial<Record<Kind, string>> = {
  openai: 'https://platform.openai.com/docs/pricing',
  vertex: 'https://cloud.google.com/vertex-ai/generative-ai/pricing',
};

/**
 * Settings → AI providers. The simple path is the top card: pick the main and
 * fast model from whatever is connected. Connecting a provider and adding its
 * models sits below, because it happens once.
 */
export function AiProvidersPanel({ settings }: { settings: ModelProviderSettingsView }) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [listings, setListings] = useState<Record<string, ProviderModelListing[]>>({});

  const run = <T extends { error?: string }>(
    key: string,
    action: () => Promise<T>,
    after?: (result: T) => void,
  ) => {
    setError(null);
    setNotice(null);
    setPendingAction(key);
    startTransition(async () => {
      try {
        const result = await action();
        if (result.error) setError(result.error);
        else after?.(result);
      } catch {
        setError('That did not save. Try again.');
      } finally {
        setPendingAction(null);
      }
    });
  };

  const connectionLabel = useMemo(
    () => new Map(settings.connections.map((c) => [c.id, c.label])),
    [settings.connections],
  );
  const usable = new Set(settings.connections.filter((c) => c.enabled).map((c) => c.id));
  const chatModels = settings.models.filter(
    (model) =>
      model.routable && !model.embedding && !model.realtime && usable.has(model.connectionId),
  );
  const voiceModels = settings.models.filter(
    (model) => model.routable && model.realtime && usable.has(model.connectionId),
  );
  const [voiceModel, setVoiceModel] = useState(settings.voiceModel ?? '');
  const groups = [...new Set(chatModels.map((model) => model.connectionId))].map((id) => ({
    id,
    label: connectionLabel.get(id) ?? id,
    models: chatModels.filter((model) => model.connectionId === id),
  }));

  const [mainModel, setMainModel] = useState(settings.mainModel ?? '');
  const [fastModel, setFastModel] = useState(settings.fastModel ?? '');
  const changed = mainModel !== settings.mainModel || fastModel !== settings.fastModel;

  const modelSelect = (value: string, onChange: (value: string) => void, label: string) => (
    <label className={field}>
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={inputClass}
      >
        {!chatModels.some((model) => model.id === value) ? (
          <option value={value}>{value || 'Choose a model'}</option>
        ) : null}
        {groups.map((group) => (
          <optgroup key={group.id} label={group.label}>
            {group.models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label} · ${Number(model.promptCostPerMTok).toFixed(2)} / $
                {Number(model.completionCostPerMTok).toFixed(2)} per M
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-2xl bg-sunken/55 p-4">
        <p className="text-sm leading-6 text-muted">
          The <strong className="text-strong">main model</strong> plans, uses tools and writes your
          replies. The <strong className="text-strong">fast model</strong> handles background
          sorting, extraction and rewriting. Each keeps a fallback on its current provider while
          that provider stays connected.
        </p>
        <form
          className="mt-3 grid gap-3 md:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              'choose',
              () => chooseTextModelsAction({ mainModel, fastModel }),
              () => setNotice('Saved. New work uses these models within 30 seconds.'),
            );
          }}
        >
          {modelSelect(mainModel, setMainModel, 'Main model')}
          {modelSelect(fastModel, setFastModel, 'Fast model')}
          <button
            type="submit"
            disabled={pending || !changed || !mainModel || !fastModel}
            className={`${btn.primary} justify-center md:col-span-2 md:justify-self-start`}
          >
            {pendingAction === 'choose' ? (
              <LoaderCircle className="size-4 motion-safe:animate-spin" />
            ) : (
              <Check className="size-4" />
            )}
            Use these
          </button>
        </form>
      </div>

      <div className="rounded-2xl bg-sunken/55 p-4">
        <p className="text-sm font-medium text-strong">Voice model (phone calls)</p>
        <p className="mt-1 text-sm leading-6 text-muted">
          The live speech model that holds phone conversations for you. It is billed per audio token
          by its provider, on top of the phone line’s per-minute rate.
        </p>
        {voiceModels.length > 0 ? (
          <form
            className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              run(
                'voice',
                () => chooseVoiceModelAction(voiceModel),
                () => setNotice('Saved. The next call uses this voice model.'),
              );
            }}
          >
            <label className={field}>
              Voice model
              <select
                value={voiceModel}
                onChange={(event) => setVoiceModel(event.target.value)}
                className={selectClass}
              >
                {!voiceModels.some((model) => model.id === voiceModel) ? (
                  <option value={voiceModel}>{voiceModel || 'Choose a voice model'}</option>
                ) : null}
                {voiceModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label} · audio ${model.audioInputPerMTok?.toFixed(2)} / $
                    {model.audioOutputPerMTok?.toFixed(2)} per M
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              disabled={pending || !voiceModel || voiceModel === settings.voiceModel}
              className={`${btn.primary} justify-center`}
            >
              {pendingAction === 'voice' ? (
                <LoaderCircle className="size-4 motion-safe:animate-spin" />
              ) : (
                <Check className="size-4" />
              )}
              Use for calls
            </button>
          </form>
        ) : null}
        {settings.voicePresets.length > 0 ? (
          <ul className="mt-3 grid gap-2">
            {settings.voicePresets.map((preset) => (
              <li
                key={`${preset.connectionId}:${preset.model}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-edge bg-raised px-3 py-2"
              >
                <span className="min-w-0 text-sm">
                  <span className="font-medium text-strong">{preset.label}</span>
                  <span className="text-muted"> — {preset.note}</span>
                </span>
                <button
                  type="button"
                  disabled={pending}
                  className={btnSm.outline}
                  onClick={() =>
                    run(`preset:${preset.model}`, () =>
                      addVoicePresetAction({
                        connectionId: preset.connectionId,
                        model: preset.model,
                      }),
                    )
                  }
                >
                  <Plus className="size-3" />
                  Add
                </button>
              </li>
            ))}
          </ul>
        ) : voiceModels.length === 0 ? (
          <p className="mt-3 text-sm text-muted">
            Connect OpenAI or Google Vertex AI below to add a voice model.
          </p>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
          {notice}
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        {settings.connections.map((connection) => {
          const key = (name: string) => `${name}:${connection.id}`;
          const enabledCount = settings.models.filter(
            (m) => m.connectionId === connection.id && m.enabled,
          ).length;
          return (
            <article key={connection.id} className="rounded-2xl border border-edge bg-raised p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-medium text-strong">{connection.label}</h3>
                    {connection.label !== KIND_LABEL[connection.kind] ? (
                      <Badge tone="neutral" size="xs">
                        {KIND_LABEL[connection.kind]}
                      </Badge>
                    ) : null}
                    {!connection.enabled ? (
                      <Badge tone="neutral" size="xs">
                        Off
                      </Badge>
                    ) : connection.lastError ? (
                      <Badge tone="red" size="xs">
                        Needs attention
                      </Badge>
                    ) : connection.lastTestedAt ? (
                      <Badge tone="green" size="xs">
                        Connected
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    {connection.source === 'environment'
                      ? 'Set up with this deployment'
                      : connection.kind === 'vertex'
                        ? 'Uses this server’s Google Cloud credentials'
                        : connection.hasApiKey
                          ? 'API key saved (encrypted)'
                          : 'No API key'}
                    {connection.baseUrl ? ` · ${connection.baseUrl}` : ''}
                    {` · ${enabledCount} ${enabledCount === 1 ? 'model' : 'models'}`}
                  </p>
                  {connection.lastError ? (
                    <p className="mt-2 text-sm text-red-600 dark:text-red-400">
                      {connection.lastError}
                    </p>
                  ) : null}
                </div>
                <div className="flex min-w-0 flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={pending}
                    className={btnSm.outline}
                    onClick={() =>
                      run(
                        key('test'),
                        () => testProviderConnectionAction(connection.id),
                        (r) =>
                          setListings((current) => ({
                            ...current,
                            [connection.id]: r.models ?? [],
                          })),
                      )
                    }
                  >
                    {pendingAction === key('test') ? (
                      <LoaderCircle className="size-3 motion-safe:animate-spin" />
                    ) : (
                      <RefreshCw className="size-3" />
                    )}
                    Test & add models
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    className={btnSm.outline}
                    onClick={() =>
                      run(key('enabled'), () =>
                        setProviderConnectionEnabledAction(connection.id, !connection.enabled),
                      )
                    }
                  >
                    {connection.enabled ? 'Turn off' : 'Turn on'}
                  </button>
                  {connection.source === 'saved' ? (
                    <ConfirmButton
                      size="sm"
                      disabled={pending}
                      confirmLabel="Confirm remove"
                      title={`Remove ${connection.label} and its saved key`}
                      onConfirm={() =>
                        run(key('remove'), () => removeProviderConnectionAction(connection.id))
                      }
                    >
                      <Trash2 className="size-3" />
                      Remove
                    </ConfirmButton>
                  ) : null}
                </div>
              </div>
              <AddModel
                connection={connection}
                listing={listings[connection.id]}
                disabled={pending}
                onAdd={(input, after) =>
                  run(key('add'), () => addProviderModelAction(input), after)
                }
                adding={pendingAction === key('add')}
              />
            </article>
          );
        })}
      </div>

      <ConnectForm
        pending={pending}
        saving={pendingAction === 'connect'}
        onSave={(input, after) =>
          run(
            'connect',
            () => saveProviderConnectionAction(input),
            (result) => {
              if (result.id)
                setListings((current) => ({
                  ...current,
                  [result.id as string]: result.models ?? [],
                }));
              setNotice(
                result.testError
                  ? `Saved, but the test failed: ${result.testError}`
                  : 'Connected. Add the models you want to use below.',
              );
              after();
            },
          )
        }
      />
    </div>
  );
}

function AddModel({
  connection,
  listing,
  disabled,
  adding,
  onAdd,
}: {
  connection: ModelProviderSettingsView['connections'][number];
  listing: ProviderModelListing[] | undefined;
  disabled: boolean;
  adding: boolean;
  onAdd: (
    input: {
      connectionId: string;
      model: string;
      label?: string;
      promptCostPerMTok: string;
      completionCostPerMTok: string;
      thinking?: boolean;
    },
    after: () => void,
  ) => void;
}) {
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [completion, setCompletion] = useState('');
  const known = listing?.find((entry) => entry.model === model);
  const listId = `models-${connection.id}`;
  const pricing = PRICING_URL[connection.kind];
  return (
    <details className="mt-3 border-t border-edge pt-3" open={listing !== undefined}>
      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted">
        <Plus className="size-3" aria-hidden="true" />
        Add a model
      </summary>
      <form
        className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,0.6fr)_minmax(0,0.6fr)_auto] sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          onAdd(
            {
              connectionId: connection.id,
              model,
              label: known?.label,
              promptCostPerMTok: prompt,
              completionCostPerMTok: completion,
              thinking: known?.thinking,
            },
            () => {
              setModel('');
              setPrompt('');
              setCompletion('');
            },
          );
        }}
      >
        <label className={field}>
          Model
          <input
            required
            list={listId}
            value={model}
            onChange={(event) => {
              const next = event.target.value;
              setModel(next);
              const match = listing?.find((entry) => entry.model === next);
              if (match?.promptCostPerMTok) setPrompt(match.promptCostPerMTok);
              if (match?.completionCostPerMTok) setCompletion(match.completionCostPerMTok);
            }}
            placeholder={connection.kind === 'openai' ? 'gpt-5.1' : 'model name'}
            className={inputClass}
            autoCapitalize="none"
            spellCheck={false}
          />
          <datalist id={listId}>
            {listing?.map((entry) => (
              <option key={entry.model} value={entry.model}>
                {entry.label}
              </option>
            ))}
          </datalist>
        </label>
        <label className={field}>
          $ / M input
          <input
            required
            inputMode="decimal"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            className={inputClass}
          />
        </label>
        <label className={field}>
          $ / M output
          <input
            required
            inputMode="decimal"
            value={completion}
            onChange={(event) => setCompletion(event.target.value)}
            className={inputClass}
          />
        </label>
        <button type="submit" disabled={disabled} className={`${btnSm.outline} justify-center`}>
          {adding ? <LoaderCircle className="size-3 motion-safe:animate-spin" /> : null}
          Add
        </button>
      </form>
      <p className="mt-2 text-xs leading-5 text-muted">
        Prices keep your spending caps accurate; a model without them can’t be used.
        {pricing ? (
          <>
            {' '}
            <a href={pricing} target="_blank" rel="noreferrer" className="underline">
              {KIND_LABEL[connection.kind]} pricing
            </a>
          </>
        ) : null}
      </p>
    </details>
  );
}

function ConnectForm({
  pending,
  saving,
  onSave,
}: {
  pending: boolean;
  saving: boolean;
  onSave: (
    input: {
      kind: Kind;
      id?: string;
      label?: string;
      apiKey?: string;
      baseUrl?: string;
      vertexProject?: string;
      vertexLocation?: string;
    },
    after: () => void,
  ) => void;
}) {
  const [kind, setKind] = useState<Kind>('openai');
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [project, setProject] = useState('');
  const [location, setLocation] = useState('');
  const help = KEY_HELP[kind];
  return (
    <form
      className="grid gap-3 rounded-2xl bg-sunken/55 p-4 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(
          {
            kind,
            id: kind === 'openai_compatible' ? id : undefined,
            label: label || undefined,
            apiKey: apiKey || undefined,
            baseUrl: kind === 'openai_compatible' ? baseUrl : undefined,
            vertexProject: kind === 'vertex' ? project : undefined,
            vertexLocation: kind === 'vertex' ? location : undefined,
          },
          () => {
            setApiKey('');
            setId('');
            setLabel('');
            setBaseUrl('');
          },
        );
      }}
    >
      <p className="text-sm font-medium text-strong sm:col-span-2">Connect a provider</p>
      <label className={field}>
        Provider
        <select
          value={kind}
          onChange={(event) => {
            setApiKey('');
            setKind(event.target.value as Kind);
          }}
          disabled={pending || saving}
          className={selectClass}
        >
          {(Object.keys(KIND_LABEL) as Kind[]).map((value) => (
            <option key={value} value={value}>
              {KIND_LABEL[value]}
            </option>
          ))}
        </select>
      </label>
      <label className={field}>
        <span>
          Name <span className="font-normal normal-case text-muted">(optional)</span>
        </span>
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder={KIND_LABEL[kind]}
          className={inputClass}
          maxLength={60}
        />
      </label>
      {kind === 'openai_compatible' ? (
        <>
          <label className={field}>
            Short id
            <input
              required
              value={id}
              onChange={(event) => setId(event.target.value.toLowerCase())}
              placeholder="groq"
              pattern="[a-z0-9][a-z0-9-]{0,39}"
              className={inputClass}
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label className={field}>
            Base URL
            <input
              required
              type="url"
              value={baseUrl}
              onChange={(event) => {
                setApiKey('');
                setBaseUrl(event.target.value);
              }}
              disabled={pending || saving}
              placeholder="https://api.groq.com/openai/v1"
              className={inputClass}
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
        </>
      ) : null}
      {kind === 'vertex' ? (
        <>
          <label className={field}>
            Google Cloud project
            <input
              value={project}
              onChange={(event) => setProject(event.target.value)}
              placeholder="this deployment’s project"
              className={inputClass}
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label className={field}>
            Location
            <input
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              placeholder="us-central1"
              className={inputClass}
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
        </>
      ) : (
        <label className={`${field} sm:col-span-2`}>
          API key
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={
              help
                ? `${help.placeholder}  ·  stored encrypted, never shown again`
                : 'Stored encrypted, never shown again'
            }
            className={inputClass}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
          {help ? (
            <a
              href={help.url}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-normal normal-case text-muted underline"
            >
              Get {kind === 'openai' ? 'an' : 'a'} {KIND_LABEL[kind]} key
            </a>
          ) : null}
        </label>
      )}
      <div className="sm:col-span-2">
        <button type="submit" disabled={pending} className={btn.primary}>
          {saving ? (
            <LoaderCircle className="size-4 motion-safe:animate-spin" />
          ) : (
            <KeyRound className="size-4" />
          )}
          {saving ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </form>
  );
}
