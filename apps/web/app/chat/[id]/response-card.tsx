'use client';

import {
  type GENERATED_CARD_LIMITS,
  generatedBlockCapability,
  generatedSpecBlockCapability,
} from '@assistant/persistence/card-capabilities';
import {
  type CardForm,
  CardFormSchema,
  type CardFormValues,
} from '@assistant/persistence/card-form';
import { isSensitiveCardFact, publicCardText } from '@assistant/persistence/card-privacy';
/*
 * Rich response cards — the structured `data-card` parts the executor attaches
 * to a final reply (response-cards.ts in core). The iOS app has rendered these
 * for a while; this is the web surface for the same payloads. When cards are
 * present they ARE the answer, so the chat suppresses the prose bubble that
 * would restate them (mirroring iOS's usesPrimaryCards).
 *
 * Payloads arrive as unknown jsonb and are parsed defensively field by field —
 * an older or newer server build may carry more or less than these types name.
 */
import {
  AlertTriangle,
  BedDouble,
  Bell,
  CalendarDays,
  Car,
  CheckCircle2,
  Clock,
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudHail,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  CreditCard,
  Droplets,
  FileText,
  FolderOpen,
  GitBranch,
  Globe,
  Heart,
  ListChecks,
  type LucideIcon,
  Mail,
  MapPin,
  MessageCircle,
  Music,
  Package,
  Plane,
  RotateCw,
  Sparkles,
  Star,
  Sun,
  Table2,
  Ticket,
  TrainFront,
  Trophy,
  Umbrella,
  Users,
  Utensils,
  Video,
  Wind,
} from 'lucide-react';
import Image from 'next/image';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { chip, focusRing, microLabelClass } from '@/lib/ui';
import { CardFormBlock } from './card-form-block';
import type { CardFormDraft, CardFormIdentity } from './card-form-operations';
import { requestCardPolling } from './card-refresh-events';
import { CardRefreshReceiptStorageError, submitCardRefresh } from './card-refresh-operations';
import { CardSteps, cardStepsOf } from './card-steps';
import { type CardRefreshAttempt, cardIsRefreshing } from './generated-card-state';
import { RouteCard } from './route-card';
import { ScoreboardCard } from './scoreboard-card';
import { SensitiveValue } from './sensitive-value';

// Cards fill the transcript column, matching the native chat surface. The
// column itself owns the readable desktop measure; a second, narrower card cap
// made structured results look disconnected from the conversation around them.
const CARD_WIDTH = 'min-w-0 w-full max-w-none';
const PREVIEW_LIMIT = 3;

type Raw = Record<string, unknown>;

export interface CardRefreshResult {
  ok: boolean;
  taskId?: string;
  error?: string;
}

type RefreshCard = (
  cardId: string,
  expectedRevisionId: string,
  operationId: string,
) => Promise<CardRefreshResult>;

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * A finite number, or undefined. Never coerce with a bare `Number()`: a card
 * field that is absent serialises as null, and `Number(null)` is 0 — which on
 * a provenance card reads as a measured zero rather than "not known".
 */
function num(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * A URL safe to put in an href. Card payloads are built from tool results —
 * search hits, mail and Drive links — so they carry the same reach as any
 * other model-adjacent input. Prose links get this for free from
 * react-markdown's URL transform; React itself only warns on a
 * `javascript:` href, so the cards need their own guard. Callers render plain
 * text when this returns empty.
 */
function cardHref(value: unknown): string {
  const raw = str(value);
  if (!raw) return '';
  try {
    const protocol = new URL(raw).protocol;
    return protocol === 'http:' || protocol === 'https:' ? raw : '';
  } catch {
    // Not absolute, so not something to link out to either.
    return '';
  }
}

function strs(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function rec(value: unknown): Raw | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : undefined;
}

function recs(value: unknown): Raw[] {
  return Array.isArray(value) ? recs0(value) : [];
}

function recs0(value: unknown[]): Raw[] {
  const out: Raw[] = [];
  for (const item of value) {
    const parsed = rec(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

function pairs(value: unknown): Array<{ label: string; value: string }> {
  return recs(value).flatMap((entry) => {
    const label = str(entry.label);
    const text = str(entry.value);
    return label && text ? [{ label, value: text }] : [];
  });
}

function link(value: unknown): { label: string; url: string } | undefined {
  const parsed = rec(value);
  if (!parsed) return undefined;
  const url = cardHref(parsed.url);
  if (!url) return undefined;
  return { label: str(parsed.label) || 'Open', url };
}

function timeRange(start: string, end: string, timeZone: string): string {
  const fmt = (value: string) => {
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return value;
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
    }).format(date);
  };
  return [fmt(start), end ? fmt(end) : ''].filter(Boolean).join('–');
}

export function generatedFactRevealKey(revision: string, id: string, value: string): string {
  return JSON.stringify([revision, id, value]);
}

function availabilityInterval(start: string, end: string, timeZone: string): string {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 'Time unavailable';
  const dateLabel = (value: string) =>
    new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone,
    }).format(new Date(value));
  const startDate = dateLabel(start);
  const endDate = dateLabel(end);
  const times = timeRange(start, end, timeZone);
  return startDate === endDate ? `${startDate} · ${times}` : `${startDate} ${times} → ${endDate}`;
}

function shortDate(value: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(date);
}

function CardShell({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof CalendarDays;
  label: string;
  children: ReactNode;
}) {
  return (
    <section
      data-response-card="true"
      className={`paper relative ${CARD_WIDTH} overflow-hidden rounded-[var(--radius-card)] border border-edge/70 bg-raised`}
    >
      <header className="flex min-h-11 items-center gap-2.5 border-b border-edge/60 px-4 py-2.5 sm:px-5">
        <Icon className="size-4 shrink-0 stroke-[1.75] text-accent" aria-hidden="true" />
        <p className="min-w-0 truncate text-sm leading-5 font-medium text-strong">{label}</p>
      </header>
      <div className="min-w-0 px-4 pt-3 pb-4 sm:px-5">{children}</div>
    </section>
  );
}

function CardOverflow({ count, children }: { count: number; children: ReactNode }) {
  if (count <= 0) return null;
  return (
    <details className="mt-3 border-t border-edge/60 pt-2.5">
      <summary
        className={`disclosure flex cursor-pointer select-none items-center gap-2 rounded-sm text-xs font-medium text-muted ${focusRing}`}
      >
        {count} more
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

function CardLink({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={chip.accent}>
      {label}
    </a>
  );
}

function DetailRows({ items }: { items: Array<{ label: string; value: string }> }) {
  if (items.length === 0) return null;
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-1">
      {items.map((item) => (
        <div
          key={`${item.label}-${item.value}`}
          className="flex min-w-0 items-baseline gap-1.5 text-xs"
        >
          <dt className="text-muted">{item.label}</dt>
          <dd className="min-w-0 break-words font-medium text-strong [overflow-wrap:anywhere]">
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The card names its own sky (`symbol`, from response-cards.ts) rather than
 * leaving the web to re-parse the description. An older payload carries no
 * symbol and an unknown one may arrive from a newer server, so both fall back
 * to the one glyph this card has always used.
 */
const WEATHER_ICONS: Record<string, typeof CloudSun> = {
  clear: Sun,
  'partly-cloudy': CloudSun,
  cloudy: Cloud,
  fog: CloudFog,
  drizzle: CloudDrizzle,
  rain: CloudRain,
  sleet: CloudHail,
  snow: CloudSnow,
  thunderstorm: CloudLightning,
};

function weatherIcon(symbol: unknown): typeof CloudSun {
  return WEATHER_ICONS[str(symbol)] ?? CloudSun;
}

/**
 * A weather detail keeps the sky its server named, which `pairs` drops.
 */
function weatherDetails(value: unknown): Array<{ label: string; value: string; symbol: string }> {
  return recs(value).flatMap((entry) => {
    const label = str(entry.label);
    const text = str(entry.value);
    return label && text ? [{ label, value: text, symbol: str(entry.symbol) }] : [];
  });
}

/**
 * Rows whose label opens with a day ("Fri", "Thu Morning") belong to that day
 * rather than to the current conditions, and group under it — one line for a
 * plain forecast day, one line per part of the day when the owner asked about
 * a single day. Mirrors WeatherPresentation.split on iOS, so a payload reads
 * the same on both surfaces.
 */
const WEATHER_DAY =
  /^(saturday|sunday|monday|tuesday|wednesday|thursday|friday|tomorrow|sat|sun|mon|tue|wed|thu|fri)\b[:\s–-]*(.*)$/i;

function splitWeatherDays(details: ReturnType<typeof weatherDetails>) {
  const current: ReturnType<typeof weatherDetails> = [];
  const order: string[] = [];
  const byDay = new Map<string, ReturnType<typeof weatherDetails>>();
  for (const detail of details) {
    const match = WEATHER_DAY.exec(detail.label);
    if (!match?.[1]) {
      current.push(detail);
      continue;
    }
    const day = match[1];
    if (!byDay.has(day)) {
      order.push(day);
      byDay.set(day, []);
    }
    byDay.get(day)?.push({ ...detail, label: match[2]?.trim() ?? '' });
  }
  return { current, days: order.map((day) => ({ day, facts: byDay.get(day) ?? [] })) };
}

function WeatherDayRow({ day, facts }: { day: string; facts: ReturnType<typeof weatherDetails> }) {
  return (
    <div className="flex gap-3 py-1.5 text-xs">
      <p className="w-14 shrink-0 font-medium text-strong capitalize">{day}</p>
      <div className="flex min-w-0 flex-col gap-1">
        {facts.map((fact) => {
          const Icon = weatherIcon(fact.symbol);
          return (
            <p key={`${fact.label}-${fact.value}`} className="flex items-baseline gap-1.5">
              <Icon className="size-3.5 shrink-0 translate-y-0.5 text-accent" aria-hidden="true" />
              {fact.label ? <span className="text-muted">{fact.label}</span> : null}
              <span className="min-w-0 text-strong">{fact.value}</span>
            </p>
          );
        })}
      </div>
    </div>
  );
}

interface WeatherDay {
  weekday: string;
  lowC: number;
  highC: number;
  precipPct?: number;
  description: string;
  symbol: string;
}

/** The forecast as numbers (`days` on newer payloads); empty on older ones. */
function weatherDays(value: unknown): WeatherDay[] {
  return recs(value).flatMap((entry) => {
    const weekday = str(entry.weekday);
    const lowC = num(entry.lowC);
    const highC = num(entry.highC);
    if (!weekday || lowC === undefined || highC === undefined) return [];
    const precipPct = num(entry.precipPct);
    return [
      {
        weekday,
        lowC: Math.round(lowC),
        highC: Math.round(highC),
        ...(precipPct === undefined ? {} : { precipPct: Math.round(precipPct) }),
        description: str(entry.description),
        symbol: str(entry.symbol),
      },
    ];
  });
}

/**
 * Apple-Weather-style day rows: weekday, sky, rain chance, and the day's
 * low–high on a bar spanning the whole list's range. Fixed columns and
 * `whitespace-nowrap`, so a row never wraps on a phone. Mirrors
 * `weatherDayList` on iOS.
 */
function WeatherDayList({ days }: { days: WeatherDay[] }) {
  const floor = Math.min(...days.map((day) => day.lowC));
  const span = Math.max(Math.max(...days.map((day) => day.highC)) - floor, 1);
  return (
    <ul className="mt-2.5 flex flex-col gap-1.5 border-t border-edge/60 pt-2.5 text-sm">
      {days.map((day) => {
        const Icon = weatherIcon(day.symbol);
        const rain = day.precipPct !== undefined && day.precipPct >= 30 ? `${day.precipPct}%` : '';
        return (
          <li
            key={`${day.weekday}-${day.lowC}-${day.highC}`}
            className="grid grid-cols-[3.25rem_1.25rem_2.5rem_2rem_minmax(2.5rem,1fr)_2rem] items-center gap-2 whitespace-nowrap tabular-nums"
            aria-label={`${day.weekday}, ${day.description}, low ${day.lowC}°, high ${day.highC}°${rain ? `, ${rain} chance of rain` : ''}`}
          >
            <span className="font-medium text-strong" aria-hidden="true">
              {day.weekday}
            </span>
            <Icon className="size-4 text-accent" aria-hidden="true" />
            <span className="text-xs font-semibold text-accent" aria-hidden="true">
              {rain}
            </span>
            <span className="text-right text-muted" aria-hidden="true">
              {day.lowC}°
            </span>
            <span className="relative h-1.5 rounded-full bg-sunken" aria-hidden="true">
              <span
                className="absolute inset-y-0 rounded-full bg-accent"
                style={{
                  left: `${((day.lowC - floor) / span) * 100}%`,
                  width: `max(${((day.highC - day.lowC) / span) * 100}%, 0.375rem)`,
                }}
              />
            </span>
            <span className="text-strong" aria-hidden="true">
              {day.highC}°
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Wind, humidity, and rain chance as one quiet row of icon-led readings. */
function WeatherMetrics({ current }: { current: Raw }) {
  const readings = [
    { label: 'Wind', value: num(current.windKmh), unit: ' km/h', Icon: Wind },
    { label: 'Humidity', value: num(current.humidity), unit: '%', Icon: Droplets },
    { label: 'Rain chance', value: num(current.precipPct), unit: '%', Icon: Umbrella },
  ].filter((reading) => reading.value !== undefined);
  if (!readings.length) return null;
  return (
    <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-strong tabular-nums">
      {readings.map(({ label, value, unit, Icon }) => (
        <span key={label} className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <Icon className="size-3.5 text-accent" aria-hidden="true" />
          <span className="sr-only">{label} </span>
          {Math.round(value ?? 0)}
          {unit}
        </span>
      ))}
    </p>
  );
}

function WeatherCard({ data }: { data: Raw }) {
  const { current, days } = splitWeatherDays(weatherDetails(data.details));
  const forecast = weatherDays(data.days);
  const reading = rec(data.current);
  // "Day" names which day the card is about; it is the card's caption rather
  // than one of its readings, so it never renders as a metric.
  const caption = current.find((detail) => detail.label.toLowerCase() === 'day')?.value;
  // With numeric days, plain day rows come from those; the text details only
  // add named parts of a day ("Thu Morning") and, on a dated card, its rain.
  const windows = forecast.length
    ? days.filter((entry) => entry.facts.some((fact) => fact.label))
    : days;
  const metrics = current.filter(
    (detail) =>
      detail.label.toLowerCase() !== 'day' &&
      !(forecast.length && (reading || detail.label.toLowerCase() === 'today')),
  );
  return (
    <CardShell icon={weatherIcon(data.symbol)} label={str(data.location) || 'Weather'}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 text-sm text-strong">
          <span className="text-base font-semibold">{str(data.temperature)}</span>{' '}
          <span className="text-muted">{str(data.condition)}</span>
        </p>
        {caption ? <p className="shrink-0 text-xs text-muted">{caption}</p> : null}
      </div>
      {forecast.length && reading ? <WeatherMetrics current={reading} /> : null}
      {metrics.length > 0 ? (
        <div className="mt-2">
          <DetailRows items={metrics} />
        </div>
      ) : null}
      {windows.length > 0 ? (
        <div className="mt-2.5 divide-y divide-edge/50 border-t border-edge/60 pt-1">
          {windows.map((entry) => (
            <WeatherDayRow
              key={entry.day}
              day={entry.day}
              facts={forecast.length ? entry.facts.filter((fact) => fact.label) : entry.facts}
            />
          ))}
        </div>
      ) : null}
      {forecast.length ? <WeatherDayList days={forecast} /> : null}
    </CardShell>
  );
}

/** One heading per briefing section, quiet and small, above its rows. */
function BriefingHeading({ children }: { children: ReactNode }) {
  return <h3 className={`mb-2 text-accent ${microLabelClass}`}>{children}</h3>;
}

function BriefingAgenda({ section }: { section: Raw }) {
  const items = recs(section.items).filter((item) => validAgendaItem(item, true));
  const days = [...new Set(items.map((item) => str(item.day)))];
  return (
    <>
      {days.map((day) => (
        <div key={day}>
          <BriefingHeading>{day}</BriefingHeading>
          <ul className="flex flex-col gap-1.5">
            {items
              .filter((item) => str(item.day) === day)
              .map((item) => {
                const flag = str(item.flag);
                return (
                  <li
                    key={`${str(item.time)}-${str(item.title)}`}
                    className="grid grid-cols-[4.75rem_1fr] gap-x-3 text-sm"
                  >
                    {/* Start over end in a fixed column, so titles line up and
                        a clock range never crowds the event it belongs to. */}
                    <span className="flex flex-col whitespace-nowrap tabular-nums">
                      <span className="text-strong">{str(item.time).split(' – ')[0]}</span>
                      {str(item.time).includes(' – ') ? (
                        <span className="text-xs text-muted">
                          {str(item.time).split(' – ').slice(1).join(' – ')}
                        </span>
                      ) : null}
                    </span>
                    <span className="min-w-0">
                      <span className="font-medium text-strong">{str(item.title)}</span>
                      {str(item.location) ? (
                        <span className="block truncate text-xs text-muted">
                          {str(item.location)}
                        </span>
                      ) : null}
                      {str(item.note) ? (
                        <span
                          className={`mt-0.5 flex items-center gap-1 text-xs ${flag === 'conflict' ? 'text-amber-800 dark:text-amber-300' : 'text-accent'}`}
                        >
                          {flag === 'conflict' ? (
                            <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
                          ) : null}
                          {str(item.note)}
                        </span>
                      ) : null}
                    </span>
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
      {section.complete === false ? (
        <p className="text-xs text-muted">
          Some calendars could not be read, so this may be incomplete.
        </p>
      ) : null}
    </>
  );
}

function BriefingWeather({ section }: { section: Raw }) {
  const Icon = weatherIcon(section.symbol);
  const extra = [str(section.range), str(section.rain)].filter(Boolean).join(' · ');
  return (
    <div>
      <BriefingHeading>{str(section.title) || 'Weather'}</BriefingHeading>
      <p className="flex items-center gap-2 text-sm text-strong">
        <Icon className="size-4 shrink-0 text-accent" aria-hidden="true" />
        <span className="font-semibold tabular-nums">{str(section.temperature)}</span>
        <span className="min-w-0 truncate text-muted">
          {str(section.condition)}
          {extra ? ` · ${extra}` : ''}
        </span>
      </p>
    </div>
  );
}

function BriefingList({ section }: { section: Raw }) {
  return (
    <div>
      <BriefingHeading>{str(section.title)}</BriefingHeading>
      <ul className="flex flex-col gap-1.5">
        {recs(section.items)
          .filter(validBriefingItem)
          .map((item) => (
            <li
              key={`${str(item.meta)}-${str(item.title)}`}
              className="flex items-baseline gap-2 text-sm"
            >
              <span className="min-w-0 flex-1">
                <span className="text-strong">{str(item.title)}</span>
                {str(item.detail) ? (
                  <span className="block text-xs text-muted [overflow-wrap:anywhere]">
                    {str(item.detail)}
                  </span>
                ) : null}
              </span>
              {str(item.meta) ? (
                <span className="shrink-0 rounded bg-sunken px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted">
                  {str(item.meta)}
                </span>
              ) : null}
            </li>
          ))}
      </ul>
    </div>
  );
}

/**
 * The daily briefing: its one-line lead, then short labelled sections built
 * from the same rows the text fallback lists. Mirrors BriefingCardView on iOS.
 */
function BriefingCard({ data }: { data: Raw }) {
  const sections = recs(data.sections).filter(validBriefingSection);
  return (
    <CardShell icon={Sun} label={['Briefing', str(data.date)].filter(Boolean).join(' · ')}>
      {str(data.lead) ? (
        <p className="text-sm font-medium text-strong text-pretty">{str(data.lead)}</p>
      ) : null}
      <div className="mt-3 flex flex-col gap-3.5 border-t border-edge/60 pt-3">
        {sections.map((section, index) => {
          const key = `${str(section.type)}-${index}`;
          switch (str(section.type)) {
            case 'agenda':
              return <BriefingAgenda key={key} section={section} />;
            case 'weather':
              return <BriefingWeather key={key} section={section} />;
            default:
              return <BriefingList key={key} section={section} />;
          }
        })}
      </div>
    </CardShell>
  );
}

function CalendarEventCard({ data }: { data: Raw }) {
  const calendar = link(data.calendarLink);
  const meeting = link(data.meetingLink);
  const attendees = strs(data.attendees).slice(0, 3);
  const calendars = strs(data.calendars);
  return (
    <CardShell icon={CalendarDays} label={str(data.time) || 'Event'}>
      <p className="text-sm font-medium text-strong">{str(data.title) || 'Untitled event'}</p>
      <div className="mt-1.5 flex flex-col gap-1 text-xs text-muted">
        {str(data.location) ? (
          <span className="flex items-center gap-1.5">
            <MapPin className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{str(data.location)}</span>
          </span>
        ) : null}
        {attendees.length > 0 ? (
          <span className="flex items-center gap-1.5">
            <Users className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{attendees.join(', ')}</span>
          </span>
        ) : null}
        {calendars.length > 1 ? (
          <span className="truncate">Across {calendars.join(' + ')}</span>
        ) : null}
      </div>
      {calendar || meeting ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {calendar ? <CardLink href={calendar.url} label={calendar.label} /> : null}
          {meeting ? (
            <span className="inline-flex items-center gap-1">
              <Video className="size-3.5 text-accent" aria-hidden="true" />
              <CardLink href={meeting.url} label={meeting.label} />
            </span>
          ) : null}
        </div>
      ) : null}
    </CardShell>
  );
}

function calendarDayLabel(value: string, timeZone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return 'Schedule';
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    // Date-only all-day events are calendar dates, not UTC instants.
    timeZone: /^\d{4}-\d{2}-\d{2}$/.test(value) ? 'UTC' : timeZone,
  }).format(date);
}

function calendarEventTime(event: Raw, timeZone: string): string {
  const start = str(event.start);
  if (event.allDay === true || /^\d{4}-\d{2}-\d{2}$/.test(start)) return 'All day';
  // Older cards saved the source clock (often UTC) alongside the timestamp.
  // Recompute from an absolute instant in the same zone used for its day heading.
  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(start) && Number.isFinite(Date.parse(start))) {
    return timeRange(start, str(event.end), timeZone);
  }
  return str(event.time);
}

function CalendarDayCard({ data, timeZone }: { data: Raw; timeZone: string }) {
  const events = recs(data.events).filter(validEvent);
  return (
    <CardShell
      icon={CalendarDays}
      label={`${str(data.title) || 'Schedule'} · ${events.length.toString()} ${events.length === 1 ? 'event' : 'events'}`}
    >
      <ol className="flex flex-col gap-4">
        {events.map((event, index) => {
          const calendar = link(event.calendarLink);
          const meeting = link(event.meetingLink);
          return (
            <li
              key={str(event.id) || index}
              className="grid min-w-0 grid-cols-[5.5rem_1fr] gap-3 border-t border-edge/55 pt-4 first:border-0 first:pt-0"
            >
              <span className="font-mono text-xs font-semibold text-accent">
                {calendarEventTime(event, timeZone)}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-strong">{str(event.title)}</span>
                {str(event.location) ? (
                  <span className="mt-1 flex items-start gap-1.5 text-xs leading-5 text-muted">
                    <MapPin className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                    <span>{str(event.location)}</span>
                  </span>
                ) : null}
                {strs(event.calendars)[0] ? (
                  <span className="mt-1 block text-xs text-muted">{strs(event.calendars)[0]}</span>
                ) : null}
                {calendar || meeting ? (
                  <span className="mt-2 flex flex-wrap gap-2">
                    {calendar ? <CardLink href={calendar.url} label={calendar.label} /> : null}
                    {meeting ? <CardLink href={meeting.url} label={meeting.label} /> : null}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
    </CardShell>
  );
}

function AgendaCard({ data }: { data: Raw }) {
  const items = recs(data.items).filter((item) => validAgendaItem(item));
  return (
    <CardShell icon={CalendarDays} label={str(data.title) || 'Your schedule'}>
      {str(data.subtitle) ? <p className="mb-3 text-xs text-muted">{str(data.subtitle)}</p> : null}
      <ol className="flex flex-col gap-3">
        {items.map((item, index) => (
          <li
            key={str(item.id) || `${str(item.time)}-${index.toString()}`}
            className="grid min-w-0 grid-cols-[5.5rem_1fr] gap-3 border-t border-edge/55 pt-3 first:border-0 first:pt-0"
          >
            <span className="font-mono text-xs font-semibold text-accent">{str(item.time)}</span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-strong">{str(item.title)}</span>
              {str(item.detail) ? (
                <span className="mt-0.5 block text-xs leading-5 text-muted">
                  {str(item.detail)}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
    </CardShell>
  );
}

function ProactiveAlertCard({ data, timeZone }: { data: Raw; timeZone: string }) {
  const category = str(data.category);
  const Icon = category === 'email' ? Mail : category === 'commitment' ? Bell : Clock;
  const details = pairs(data.details);
  const startsAt = str(data.startsAt);
  const dueAt = str(data.dueAt);
  const temporal = startsAt || dueAt;
  return (
    <CardShell icon={Icon} label={str(data.urgencyLabel) || 'Worth your attention'}>
      <p className="text-base font-semibold leading-6 text-strong">{str(data.title)}</p>
      {str(data.summary) ? (
        <p className="mt-1 text-sm leading-6 text-muted">{str(data.summary)}</p>
      ) : null}
      {temporal || details.length > 0 ? (
        <div className="mt-3 border-t border-edge/55 pt-3">
          <DetailRows
            items={[
              ...(temporal
                ? [{ label: startsAt ? 'Starts' : 'Due', value: shortDate(temporal, timeZone) }]
                : []),
              ...details.filter((item) => item.label !== 'Due'),
            ]}
          />
        </div>
      ) : null}
    </CardShell>
  );
}

function EmailResultsCard({ data, timeZone }: { data: Raw; timeZone: string }) {
  const messages = recs(data.messages).filter(validEmailResult);
  const renderMessage = (message: Raw, index: number) => (
    <li key={str(message.id) || index} className="min-w-0 text-sm">
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className="min-w-0 truncate font-medium text-strong">
          {str(message.sender) || 'Unknown sender'}
        </span>
        {str(message.date) ? (
          <span className="shrink-0 text-xs text-muted">
            {shortDate(str(message.date), timeZone)}
          </span>
        ) : null}
      </p>
      <p className="min-w-0 truncate text-sm text-strong">{str(message.subject)}</p>
      {str(message.snippet) ? (
        <p className="mt-0.5 line-clamp-2 break-words text-xs leading-5 text-muted">
          {str(message.snippet)}
        </p>
      ) : null}
    </li>
  );
  return (
    <CardShell
      icon={Mail}
      label={str(data.query) ? `Email — “${str(data.query)}”` : 'Email results'}
    >
      <ul className="flex flex-col gap-2.5">
        {messages.slice(0, PREVIEW_LIMIT).map(renderMessage)}
      </ul>
      <CardOverflow count={Math.max(0, messages.length - PREVIEW_LIMIT)}>
        <ul className="flex flex-col gap-2.5">
          {messages.slice(PREVIEW_LIMIT).map(renderMessage)}
        </ul>
      </CardOverflow>
      {data.complete === false ? (
        <p className="mt-2 text-xs text-muted">
          Showing what the search returned — more may exist.
        </p>
      ) : null}
    </CardShell>
  );
}

/** Readable source excerpts stay plain text; quoted email is never executable markup. */
function TextPreview({ text, limit = 180 }: { text: string; limit?: number }) {
  if (!text) return null;
  if (text.length <= limit)
    return (
      <p className="whitespace-pre-wrap break-words text-sm leading-6 text-muted [overflow-wrap:anywhere]">
        {text}
      </p>
    );
  const head = text.slice(0, limit);
  const preview = head.slice(0, Math.max(head.lastIndexOf(' '), Math.floor(limit * 0.75)));
  return (
    <details className="group">
      <summary
        className={`disclosure cursor-pointer list-none rounded-sm text-sm leading-6 text-muted ${focusRing}`}
      >
        <span className="break-words group-open:hidden [overflow-wrap:anywhere]">
          {preview.trimEnd()}…{' '}
        </span>
        <span className="text-xs font-medium text-accent group-open:hidden">Read more</span>
        <span className="hidden text-xs font-medium text-accent group-open:inline">Show less</span>
      </summary>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-muted [overflow-wrap:anywhere]">
        {text}
      </p>
    </details>
  );
}

function EmailThreadCard({ data, timeZone }: { data: Raw; timeZone: string }) {
  const messages = recs(data.messages).filter(validEmailThreadMessage);
  const count = Math.max(messages.length, num(data.messageCount) ?? messages.length);
  const renderMessage = (message: Raw, index: number) => (
    <li key={str(message.id) || index} className="relative min-w-0 border-l border-accent/25 pl-4">
      <span
        aria-hidden="true"
        className="absolute top-1.5 -left-1 size-2 rounded-full bg-accent/60"
      />
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <p className="min-w-0 break-words text-xs font-semibold text-strong [overflow-wrap:anywhere]">
          {str(message.sender) || 'Unknown sender'}
        </p>
        {str(message.date) ? (
          <span className="text-[11px] text-muted">{shortDate(str(message.date), timeZone)}</span>
        ) : null}
      </div>
      <TextPreview text={str(message.excerpt)} />
    </li>
  );
  return (
    <CardShell
      icon={Mail}
      label={`Email thread · ${count} ${count === 1 ? 'message' : 'messages'}`}
    >
      <h3 className="mb-3 break-words text-base font-semibold leading-6 text-strong">
        {str(data.subject) || 'Email thread'}
      </h3>
      {messages.length ? (
        <ol className="grid gap-4">{messages.slice(0, PREVIEW_LIMIT).map(renderMessage)}</ol>
      ) : (
        <p className="text-sm text-muted">No message preview is available.</p>
      )}
      <CardOverflow count={Math.max(0, messages.length - PREVIEW_LIMIT)}>
        <ol start={PREVIEW_LIMIT + 1} className="grid gap-4">
          {messages.slice(PREVIEW_LIMIT).map(renderMessage)}
        </ol>
      </CardOverflow>
      {count > messages.length ? (
        <p className="mt-3 text-xs text-muted">
          {messages.length} of {count} messages included in this preview.
        </p>
      ) : null}
    </CardShell>
  );
}

function sheetRows(value: unknown): string[][] {
  return Array.isArray(value)
    ? value
        .filter(validSheetRow)
        .map((row) =>
          row.map((cell: unknown) =>
            typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean'
              ? String(cell)
              : '',
          ),
        )
    : [];
}

function SheetRowsCard({ data }: { data: Raw }) {
  const rows = sheetRows(data.rows);
  const count = Math.max(rows.length, num(data.totalRows) ?? rows.length);
  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const open = link(data.link);
  const title = str(data.sheetName) || 'Spreadsheet';
  const table = (entries: string[][], offset: number) => (
    <section
      className={`max-w-full overflow-x-auto rounded-lg border border-edge/60 ${focusRing}`}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: This scroll region needs keyboard access.
      tabIndex={0}
      aria-label={`${title} preview rows ${offset + 1} to ${offset + entries.length}`}
    >
      <table className="w-full border-collapse text-left text-xs">
        <caption className="sr-only">
          {title} · {count} rows · preview
        </caption>
        <thead className="bg-sunken/60 text-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              #
            </th>
            {Array.from({ length: columns }, (_, index) => (
              <th
                key={String.fromCharCode(65 + index)}
                scope="col"
                className="px-3 py-2 font-medium"
              >
                Column {index + 1}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map((row, rowIndex) => (
            <tr
              // biome-ignore lint/suspicious/noArrayIndexKey: Spreadsheet position is the stable row identity.
              key={`row-${offset + rowIndex}`}
              className="border-t border-edge/50"
            >
              <th scope="row" className="px-3 py-2 align-top font-normal text-muted">
                {offset + rowIndex + 1}
              </th>
              {Array.from({ length: columns }, (_, column) => (
                <td
                  key={String.fromCharCode(65 + column)}
                  className="min-w-24 max-w-64 break-words px-3 py-2 align-top text-strong [overflow-wrap:anywhere]"
                >
                  {row[column] || '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
  return (
    <CardShell icon={Table2} label={`Spreadsheet · ${count} ${count === 1 ? 'row' : 'rows'}`}>
      <h3 className="mb-3 break-words text-base font-semibold text-strong">{title}</h3>
      {rows.length ? (
        table(rows.slice(0, PREVIEW_LIMIT), 0)
      ) : (
        <p className="text-sm text-muted">This range has no rows.</p>
      )}
      <CardOverflow count={Math.max(0, rows.length - PREVIEW_LIMIT)}>
        {table(rows.slice(PREVIEW_LIMIT), PREVIEW_LIMIT)}
      </CardOverflow>
      {count > rows.length ? (
        <p className="mt-3 text-xs text-muted">
          Showing {rows.length} of {count} rows. Open the spreadsheet for the full range.
        </p>
      ) : null}
      {open ? (
        <div className="mt-3">
          <CardLink href={open.url} label={open.label} />
        </div>
      ) : null}
    </CardShell>
  );
}

function ResourceCard({ data }: { data: Raw }) {
  const details = pairs(data.details);
  const open = link(data.link);
  return (
    <CardShell
      icon={data.resourceType === 'spreadsheet' ? Table2 : FileText}
      label={data.resourceType === 'spreadsheet' ? 'Spreadsheet' : 'Document'}
    >
      <h3 className="break-words text-base font-semibold leading-6 text-strong">
        {str(data.title) || 'Saved resource'}
      </h3>
      {str(data.subtitle) ? <p className="mt-1 text-sm text-muted">{str(data.subtitle)}</p> : null}
      {details.length ? (
        <div className="mt-3">
          <DetailRows items={details.slice(0, 4)} />
        </div>
      ) : null}
      <CardOverflow count={Math.max(0, details.length - 4)}>
        <DetailRows items={details.slice(4)} />
      </CardOverflow>
      {open ? (
        <div className="mt-3">
          <CardLink href={open.url} label={open.label} />
        </div>
      ) : null}
      <CardSteps steps={cardStepsOf(data.steps)} />
    </CardShell>
  );
}

function WebSearchCard({ data }: { data: Raw }) {
  const results = recs(data.results).filter(validSearchResult);
  const renderResult = (result: Raw, index: number) => (
    <li key={str(result.url) || index} className="min-w-0 text-sm">
      {cardHref(result.url) ? (
        <a
          href={cardHref(result.url)}
          target="_blank"
          rel="noreferrer"
          className={`font-medium text-accent underline-offset-2 hover:underline ${focusRing}`}
        >
          {str(result.title) || str(result.url)}
        </a>
      ) : (
        <span className="font-medium text-strong">{str(result.title) || str(result.url)}</span>
      )}
      {str(result.snippet) ? (
        <p className="mt-0.5 line-clamp-2 break-words text-xs leading-5 text-muted">
          {str(result.snippet)}
        </p>
      ) : null}
    </li>
  );
  return (
    <CardShell icon={Globe} label={str(data.query) ? `Web — “${str(data.query)}”` : 'Web results'}>
      <ul className="flex flex-col gap-2.5">{results.slice(0, PREVIEW_LIMIT).map(renderResult)}</ul>
      <CardOverflow count={Math.max(0, results.length - PREVIEW_LIMIT)}>
        <ul className="flex flex-col gap-2.5">{results.slice(PREVIEW_LIMIT).map(renderResult)}</ul>
      </CardOverflow>
    </CardShell>
  );
}

function AvailabilityCard({ data, timeZone }: { data: Raw; timeZone: string }) {
  const rawBusyEntries = Array.isArray(data.busy) ? data.busy : [];
  const hasBusyArray = Array.isArray(data.busy);
  const rawBusy = recs(data.busy);
  const busy = rawBusy.filter((slot) => {
    const start = Date.parse(str(slot.start));
    const end = Date.parse(str(slot.end));
    return Number.isFinite(start) && Number.isFinite(end) && end > start;
  });
  const checked = strs(data.calendarsChecked)
    .map((calendar) => calendar.trim())
    .filter((calendar) => calendar.length > 0);
  const discardedBusyRows = !hasBusyArray || busy.length !== rawBusyEntries.length;
  const coverageComplete = data.complete === true && checked.length > 0 && !discardedBusyRows;
  return (
    <CardShell icon={Clock} label="Free / busy">
      {busy.length === 0 && coverageComplete ? (
        <p className="text-sm text-strong">No busy blocks were found in this checked window.</p>
      ) : busy.length === 0 ? (
        <p className="text-sm text-strong">Calendar availability is incomplete or unknown.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {busy.map((slot) => (
            <li
              key={`${str(slot.start)}-${str(slot.end)}-${str(slot.calendar)}`}
              className="flex min-w-0 items-baseline gap-2 text-sm"
            >
              <span className="min-w-0 flex-1 break-words font-medium text-strong">
                {availabilityInterval(str(slot.start), str(slot.end), timeZone)}
              </span>
              {str(slot.calendar) ? (
                <span className="min-w-0 truncate text-xs text-muted">{str(slot.calendar)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p role="status" aria-live="polite" className="mt-2 text-xs text-muted">
        {coverageComplete
          ? `Busy blocks${checked.length > 0 ? ` across ${checked.join(' + ')}` : ''} were fully checked; the remaining time in this window is free.`
          : `Coverage is incomplete${checked.length > 0 ? ` across the checked calendars (${checked.join(' + ')})` : ''}. Unlisted time is unknown.`}
        {discardedBusyRows ? ' Some busy intervals were malformed and could not be used.' : ''}
      </p>
      {str(data.note) ? <p className="mt-1 text-xs text-muted">{str(data.note)}</p> : null}
    </CardShell>
  );
}

function StatusCard({ data }: { data: Raw }) {
  const openLink = link(data.link);
  return (
    <CardShell icon={CheckCircle2} label={str(data.title) || 'Done'}>
      {str(data.detail) ? <p className="text-sm text-strong">{str(data.detail)}</p> : null}
      <div className="mt-1.5">
        <DetailRows items={pairs(data.details)} />
      </div>
      {openLink ? (
        <div className="mt-2.5">
          <CardLink href={openLink.url} label={openLink.label} />
        </div>
      ) : null}
    </CardShell>
  );
}

function ReminderCard({ data }: { data: Raw }) {
  return (
    <CardShell icon={Bell} label="Reminder">
      <p className="text-sm font-medium text-strong">{str(data.title)}</p>
      <div className="mt-1.5">
        <DetailRows
          items={[
            ...(str(data.nextFires) ? [{ label: 'Next', value: str(data.nextFires) }] : []),
            ...(str(data.schedule) ? [{ label: 'Schedule', value: str(data.schedule) }] : []),
          ]}
        />
      </div>
    </CardShell>
  );
}

function DriveResultsCard({ data, timeZone }: { data: Raw; timeZone: string }) {
  const files = recs(data.files).filter(validDriveFile);
  const renderFile = (file: Raw, index: number) => {
    const url = cardHref(file.url);
    const name = str(file.name) || 'Untitled file';
    return (
      <li key={str(file.id) || index} className="flex min-w-0 items-baseline gap-2 text-sm">
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className={`min-w-0 truncate font-medium text-accent underline-offset-2 hover:underline ${focusRing}`}
          >
            {name}
          </a>
        ) : (
          <span className="min-w-0 truncate font-medium text-strong">{name}</span>
        )}
        {str(file.modifiedTime) ? (
          <span className="shrink-0 text-xs text-muted">
            {shortDate(str(file.modifiedTime), timeZone)}
          </span>
        ) : null}
      </li>
    );
  };
  return (
    <CardShell
      icon={FolderOpen}
      label={str(data.query) ? `Drive — “${str(data.query)}”` : 'Drive files'}
    >
      <ul className="flex flex-col gap-2">{files.slice(0, PREVIEW_LIMIT).map(renderFile)}</ul>
      <CardOverflow count={Math.max(0, files.length - PREVIEW_LIMIT)}>
        <ul className="flex flex-col gap-2">{files.slice(PREVIEW_LIMIT).map(renderFile)}</ul>
      </CardOverflow>
    </CardShell>
  );
}

function DocumentResultsCard({ data }: { data: Raw }) {
  const passages = recs(data.passages).filter(validDocumentPassage);
  const renderPassage = (passage: Raw, index: number) => (
    <li key={str(passage.id) || index} className="min-w-0 text-sm">
      <p className="font-medium text-strong">{str(passage.document)}</p>
      {str(passage.snippet) ? (
        <p className="mt-0.5 line-clamp-2 break-words text-xs leading-5 text-muted">
          {str(passage.snippet)}
        </p>
      ) : null}
    </li>
  );
  return (
    <CardShell
      icon={FileText}
      label={str(data.query) ? `Documents — “${str(data.query)}”` : 'Document matches'}
    >
      <ul className="flex flex-col gap-2.5">
        {passages.slice(0, PREVIEW_LIMIT).map(renderPassage)}
      </ul>
      <CardOverflow count={Math.max(0, passages.length - PREVIEW_LIMIT)}>
        <ul className="flex flex-col gap-2.5">
          {passages.slice(PREVIEW_LIMIT).map(renderPassage)}
        </ul>
      </CardOverflow>
    </CardShell>
  );
}

function KnowledgeGraphCard({ data }: { data: Raw }) {
  const nodes = new Map(recs(data.nodes).map((node) => [str(node.id), node]));
  const edges = recs(data.edges).filter((edge) => validGraphEdge(edge, nodes));
  return (
    <CardShell icon={GitBranch} label={str(data.title) || 'Saved connections'}>
      <div className="flex flex-col gap-3">
        {edges.map((edge, index) => (
          <article key={str(edge.id) || index} className="relative pl-4">
            <span className="absolute top-1 bottom-1 left-0 w-px bg-accent/35" aria-hidden="true" />
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
              <span className="rounded-full bg-accent/10 px-2.5 py-1 font-medium text-strong">
                {str(edge.fromLabel) ||
                  str(recs(data.nodes).find((node) => str(node.id) === str(edge.from))?.label) ||
                  'Unknown'}
              </span>
              <span className="text-xs text-accent">—{str(edge.label) || 'connected to'}→</span>
              <span className="rounded-full bg-sunken px-2.5 py-1 font-medium text-strong">
                {str(edge.toLabel) ||
                  str(recs(data.nodes).find((node) => str(node.id) === str(edge.to))?.label) ||
                  'Unknown'}
              </span>
            </div>
            {str(edge.evidenceQuote) ? (
              <p className="mt-2 text-xs leading-5 text-strong">“{str(edge.evidenceQuote)}”</p>
            ) : null}
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
              {str(edge.source) ? <span>Source: {str(edge.source)}</span> : null}
              {num(edge.confidence) !== undefined ? (
                <span>Confidence: {Math.round((num(edge.confidence) as number) * 100)}%</span>
              ) : null}
              <span>
                {edge.ownerConfirmed === true ? 'Owner-confirmed' : 'Not owner-confirmed'}
              </span>
            </div>
          </article>
        ))}
      </div>
      {data.complete === false ? (
        <p className="mt-3 text-xs text-muted">More matching connections are available.</p>
      ) : null}
    </CardShell>
  );
}

function CalendarConflictsCard({ data, timeZone }: { data: Raw; timeZone: string }) {
  const conflicts = recs(data.conflicts).filter(validConflict);
  return (
    <CardShell icon={AlertTriangle} label={str(data.title) || 'Schedule conflict'}>
      <div className="flex flex-col gap-4">
        {conflicts.map((conflict, index) => {
          const groups = recs(conflict.groups);
          return (
            <section key={str(conflict.id) || index} aria-label={`Conflict ${index + 1}`}>
              <p className="mb-2 text-xs font-medium text-accent">
                Overlap{' '}
                {timeRange(
                  str(conflict.overlapStart),
                  str(conflict.overlapEnd),
                  str(data.timeZone) || timeZone,
                )}
              </p>
              <p className="mb-2 text-xs text-muted">
                {str(conflict.evidenceNote) ||
                  'The times overlap; personal attendance and event identity are unverified.'}
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {groups.map((group) => {
                  const events = recs(group.events);
                  const event = events[0];
                  if (!event) return null;
                  const groupKey = events
                    .map(
                      (source) =>
                        str(source.id) ||
                        `${str(source.calendar)}:${str(source.title)}:${str(source.start)}`,
                    )
                    .join('|');
                  return (
                    <div
                      key={groupKey || `${str(event.title)}:${str(event.start)}`}
                      className="rounded-lg border border-edge/70 bg-sunken/35 p-3"
                    >
                      <p className="text-sm font-medium text-strong">
                        {str(event.title) || 'Untitled event'}
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        {timeRange(
                          str(event.start),
                          str(event.end),
                          str(data.timeZone) || timeZone,
                        )}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {events.map((source, sourceIndex) => (
                          <span
                            key={str(source.id) || sourceIndex}
                            className="rounded-full border border-edge px-2 py-0.5 text-[10px] text-muted"
                          >
                            {str(source.calendar) || 'Calendar'}
                            {events.length > 1
                              ? ` · ${str(source.title)} · ${timeRange(str(source.start), str(source.end), str(data.timeZone) || timeZone)}`
                              : ''}
                          </span>
                        ))}
                      </div>
                      {str(event.location) ? (
                        <p className="mt-2 flex items-center gap-1 text-xs text-muted">
                          <MapPin className="size-3" aria-hidden="true" />
                          {str(event.location)}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      {data.complete === false ? (
        <p className="mt-3 text-xs text-muted">Some calendars could not be checked.</p>
      ) : null}
    </CardShell>
  );
}

const generatedIcons = {
  ticket: Ticket,
  plane: Plane,
  sport: Trophy,
  package: Package,
  calendar: CalendarDays,
  map: MapPin,
  music: Music,
  star: Star,
  train: TrainFront,
  car: Car,
  hotel: BedDouble,
  food: Utensils,
  money: CreditCard,
  health: Heart,
  weather: CloudSun,
  checklist: ListChecks,
  generic: Sparkles,
} as const satisfies Record<(typeof GENERATED_CARD_LIMITS.spec.icons)[number], LucideIcon>;

const UUID_IDENTITY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sameCardFormIdentity(a: CardFormIdentity, b: CardFormIdentity): boolean {
  return (
    a.conversationId === b.conversationId &&
    a.cardId === b.cardId &&
    a.revisionId === b.revisionId &&
    a.formId === b.formId
  );
}

function cardFormDefaults(form: CardForm, facts: Map<string, Raw>): CardFormValues {
  const values: CardFormValues = Object.create(null);
  for (const field of form.fields) {
    if (!field.defaultFact) continue;
    const fact = facts.get(field.defaultFact);
    if (!fact || sensitiveFactForForm(fact)) continue;
    const raw = str(fact.value);
    if (field.type === 'boolean') {
      if (raw === 'true' || raw === 'false') values[field.id] = raw === 'true';
    } else if (field.type === 'choice') {
      if (field.options.some((option) => option.id === raw)) values[field.id] = raw;
    } else if (field.type === 'date') {
      const date = /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(raw)
        ? new Date(`${raw}T00:00:00.000Z`)
        : null;
      if (date && Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === raw)
        values[field.id] = raw;
    } else if (raw) values[field.id] = raw;
  }
  return values;
}

function sensitiveFactForForm(fact: Raw): boolean {
  return isSensitiveCardFact({
    id: str(fact.id),
    label: str(fact.label),
    value: str(fact.value),
    sensitive: fact.sensitive === true,
  });
}

function GeneratedCard({
  data,
  conversationId,
  formSessionScope,
  formDraft,
  formError,
  onChangeForm,
  onReviewForm,
  onCarryForm,
  onDiscardForm,
  onSend,
  onRefresh,
  timeZone,
}: {
  data: Raw;
  conversationId?: string;
  formSessionScope?: string;
  formDraft?: CardFormDraft | null;
  formError?: string | null;
  onChangeForm?: (identity: CardFormIdentity, form: CardForm, values: CardFormValues) => void;
  onReviewForm?: (identity: CardFormIdentity, form: CardForm, values: CardFormValues) => void;
  onCarryForm?: (identity: CardFormIdentity, form: CardForm) => void;
  onDiscardForm?: (identity: CardFormIdentity) => void;
  onSend?: (text: string) => void;
  onRefresh?: RefreshCard;
  timeZone: string;
}) {
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [now, setNow] = useState<number | null>(null);
  const hasCountdown = recs(rec(data.spec)?.blocks).some(
    (block) =>
      block.type === 'countdown' ||
      (block.type === 'section' && recs(block.blocks).some((child) => child.type === 'countdown')),
  );
  useEffect(() => {
    if (!hasCountdown) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, [hasCountdown]);
  const [refreshAttempt, setRefreshAttempt] = useState<CardRefreshAttempt | null>(null);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const refreshInFlight = useRef(false);
  const spec = rec(data.spec);
  const version = num(spec?.version);
  const facts = new Map(recs(spec?.facts).map((item) => [str(item.id), item]));
  const revision = str(data.revisionId) || str(data.updatedAt);
  const sensitiveFact = (item: Raw | undefined) =>
    !!item &&
    isSensitiveCardFact({
      id: str(item.id),
      label: str(item.label),
      value: str(item.value),
      sensitive: item.sensitive === true,
    });
  const privateValues = recs(spec?.facts)
    .filter(sensitiveFact)
    .map((item) => str(item.value));
  const publicText = (value: unknown) =>
    publicCardText(str(value) || undefined, privateValues) ?? '';
  const revealKey = (id: unknown) => {
    const item = facts.get(str(id));
    return generatedFactRevealKey(revision, str(item?.id), str(item?.value));
  };
  if (!spec || version !== 1 || !str(spec.title)) return null;
  const blocks = recs(spec.blocks);
  const actions = recs(spec.actions).filter((action) => str(action.type) !== 'refresh');
  const refreshable = spec.refreshable === true;
  const refreshing = cardIsRefreshing(data, refreshAttempt);
  const refresh = async () => {
    if (refreshing || refreshInFlight.current || !onRefresh) return;
    refreshInFlight.current = true;
    setActionFeedback(null);
    const cardId = str(data.id);
    const expectedRevisionId = str(data.revisionId);
    if (!cardId || !expectedRevisionId) {
      setActionFeedback('This card version is unavailable. Reload it before refreshing.');
      refreshInFlight.current = false;
      return;
    }
    try {
      if (typeof window === 'undefined' || !window.crypto?.randomUUID)
        throw new Error('Refresh retries are unavailable in this browser session');
      setRefreshAttempt({ revision: expectedRevisionId, state: 'saving' });
      const result = await submitCardRefresh({
        cardId,
        revisionId: expectedRevisionId,
        state: {
          refreshState: data.refreshState,
          refreshTaskId: data.refreshTaskId,
        },
        storage: window.sessionStorage,
        createId: () => window.crypto.randomUUID(),
        send: onRefresh,
      });
      if (!result.ok) {
        setRefreshAttempt(null);
        setActionFeedback(result.error || 'Could not refresh this card. Try again.');
        return;
      }
      if (!result.taskId) throw new Error('Refresh task receipt is missing');
      setRefreshAttempt({
        revision: expectedRevisionId,
        taskId: result.taskId,
        state: 'refreshing',
      });
      requestCardPolling(cardId, result.taskId);
    } catch (error) {
      if (error instanceof CardRefreshReceiptStorageError) {
        setRefreshAttempt({
          revision: expectedRevisionId,
          taskId: error.taskId,
          state: 'refreshing',
        });
        requestCardPolling(cardId, error.taskId);
        setActionFeedback('Refresh started. Check its status before trying again.');
      } else {
        setRefreshAttempt(null);
        setActionFeedback('Could not confirm the refresh. Try again.');
      }
    } finally {
      refreshInFlight.current = false;
    }
  };
  const copyValue = async (text: string) => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setActionFeedback('Copied.');
    } catch {
      setActionFeedback('Could not copy. Select and copy the value instead.');
    }
  };
  const previewBlocks: Raw[] = [];
  const detailBlocks: Raw[] = [];
  for (const block of blocks) {
    if (previewBlocks.length >= 2) {
      detailBlocks.push(block);
      continue;
    }
    if (
      (block.type === 'facts' || block.type === 'timeline') &&
      Array.isArray(block.factIds) &&
      block.factIds.length > 4
    ) {
      previewBlocks.push({ ...block, factIds: block.factIds.slice(0, 4) });
      detailBlocks.push({ ...block, factIds: block.factIds.slice(4), startIndex: 5 });
    } else previewBlocks.push(block);
  }
  const icon = str(spec.icon);
  const Icon = Object.hasOwn(generatedIcons, icon)
    ? generatedIcons[icon as keyof typeof generatedIcons]
    : Sparkles;
  const fact = (id: unknown) => facts.get(str(id));
  const value = (id: unknown) => str(fact(id)?.value);
  const toggleReveal = (id: unknown) =>
    setRevealed((current) => {
      const next = new Set(current);
      const key = revealKey(id);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  /**
   * A fact as the card shows it. A sensitive one is a real button that masks
   * and unmasks itself — it used to render as bullets with no way to read it
   * except an optional `reveal_sensitive` action the compiler often left off,
   * so the number the card existed for was simply not there.
   */
  const shownValue = (id: unknown, className?: string) => {
    const item = fact(id);
    if (!item) return null;
    const text = str(item.value);
    if (!sensitiveFact(item)) return publicText(text);
    return (
      <SensitiveValue
        value={text}
        label={publicText(item.label)}
        revealed={revealed.has(revealKey(item.id))}
        onToggle={() => toggleReveal(item.id)}
        className={className}
      />
    );
  };

  const shownDateValue = (id: unknown): ReactNode => {
    const item = fact(id);
    const raw = value(id);
    if (
      sensitiveFact(item) ||
      !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(raw) ||
      !Number.isFinite(Date.parse(raw))
    )
      return shownValue(id);
    let display: string;
    try {
      display = new Intl.DateTimeFormat('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
        timeZone,
      }).format(new Date(raw));
    } catch {
      return shownValue(id);
    }
    return (
      <time dateTime={raw} title={raw}>
        {publicText(display)}
      </time>
    );
  };

  const numericValue = (id: unknown): number | null => {
    const item = fact(id);
    if (!item || (sensitiveFact(item) && !revealed.has(revealKey(id)))) return null;
    const raw = str(item.value).replace(/%$/, '').trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) return null;
    const number = Number(raw);
    return Number.isFinite(number) ? number : null;
  };

  const renderBlock = (block: Raw, depth = 0): ReactNode => {
    const type = str(block.type);
    if (
      !generatedBlockCapability(block, facts, 'web', depth, {
        formRendererAvailable: Boolean(
          conversationId && formSessionScope && onReviewForm && onChangeForm,
        ),
      }).shell
    )
      return null;
    const blockKey = JSON.stringify(block);
    if (type === 'section') {
      if (depth !== 0) return null;
      return (
        <section key={blockKey} aria-label={publicText(block.title)} className="grid gap-3">
          <h4 className="text-sm font-semibold text-strong">{publicText(block.title)}</h4>
          {recs(block.blocks).map((child) => renderBlock(child, depth + 1))}
        </section>
      );
    }
    if (type === 'form') {
      const parsed = CardFormSchema.safeParse(block);
      if (!parsed.success) return null;
      const form = parsed.data;
      const identity =
        conversationId &&
        UUID_IDENTITY.test(conversationId) &&
        UUID_IDENTITY.test(str(data.id)) &&
        UUID_IDENTITY.test(str(data.revisionId))
          ? {
              conversationId,
              cardId: str(data.id),
              revisionId: str(data.revisionId),
              formId: form.id,
            }
          : null;
      const matchingDraft =
        identity && formDraft && sameCardFormIdentity(formDraft.identity, identity)
          ? formDraft
          : null;
      const staleDraft =
        !!formDraft &&
        !!identity &&
        !matchingDraft &&
        !formDraft.operation &&
        !formDraft.blockedByTask &&
        formDraft.identity.conversationId === identity.conversationId &&
        formDraft.identity.cardId === identity.cardId &&
        formDraft.identity.formId === identity.formId;
      const carryableDraft = staleDraft;
      const defaults = cardFormDefaults(form, facts);
      const values = matchingDraft?.values ?? (carryableDraft ? formDraft.values : defaults);
      const warningFacts = form.warningFactIds.flatMap((id) => {
        const item = facts.get(id);
        return item && !sensitiveFact(item) && str(item.value)
          ? [{ id, label: publicText(item.label) || id, value: publicText(item.value) }]
          : [];
      });
      const canReview = !!identity && !!formSessionScope && !!onReviewForm && !!onChangeForm;
      const lockedReason = staleDraft
        ? null
        : formDraft?.blockedByTask
          ? 'Another request for this form is still running. Your message remains an unsent draft; send it after the task finishes.'
          : formDraft?.operation
            ? formDraft.operation.taskId
              ? 'This request is waiting for its exact task result. Its answers and message stay fixed.'
              : 'The result of this request is unconfirmed. Retry the same message before changing its answers.'
            : formDraft && !matchingDraft
              ? 'Review or clear the current form draft before opening another form.'
              : null;
      const editable =
        canReview &&
        !formDraft?.operation &&
        !formDraft?.blockedByTask &&
        (!formDraft || !!matchingDraft);
      return (
        <CardFormBlock
          key={blockKey}
          form={form}
          identity={identity}
          values={values}
          warningFacts={warningFacts}
          editable={editable}
          staleDraft={staleDraft}
          error={formError}
          lockedReason={lockedReason}
          onChange={
            identity && onChangeForm ? (next) => onChangeForm(identity, form, next) : undefined
          }
          onReview={
            canReview && identity ? (next) => onReviewForm?.(identity, form, next) : undefined
          }
          onCarry={
            carryableDraft && identity && onCarryForm
              ? () => onCarryForm(identity, form)
              : undefined
          }
          onDiscard={
            formDraft &&
            !formDraft.operation &&
            !formDraft.blockedByTask &&
            identity &&
            onDiscardForm
              ? () => onDiscardForm(identity)
              : undefined
          }
        />
      );
    }
    if (type === 'hero') {
      return (
        <div key={blockKey} className="border-y border-edge/60 py-3">
          <p className="text-xl font-semibold tracking-[-0.025em] text-strong">
            {shownValue(block.titleFact, 'text-xl font-semibold tracking-[-0.025em]')}
          </p>
          {value(block.subtitleFact) ? (
            <p className="mt-1 text-sm text-muted">{shownValue(block.subtitleFact)}</p>
          ) : null}
        </div>
      );
    }
    if (type === 'timeline') {
      const items = Array.isArray(block.factIds) ? block.factIds : [];
      return (
        <ol
          key={blockKey}
          aria-label="Timeline"
          start={num(block.startIndex) ?? 1}
          className="ml-3 grid gap-4 border-l border-accent/30 pl-4"
        >
          {items.map((id, index) => {
            const item = fact(id);
            if (!item) return null;
            return (
              <li key={str(item.id)} className="relative min-w-0">
                <span
                  aria-hidden="true"
                  className="absolute top-0 -left-7 flex size-5 items-center justify-center rounded-full border border-accent/25 bg-raised text-[10px] font-semibold text-accent"
                >
                  {(num(block.startIndex) ?? 1) + index}
                </span>
                <p className="text-xs font-medium text-muted">{publicText(item.label) || 'Step'}</p>
                <p className="mt-0.5 break-words text-sm font-medium text-strong [overflow-wrap:anywhere]">
                  {shownValue(item.id, 'text-sm font-medium')}
                </p>
              </li>
            );
          })}
        </ol>
      );
    }
    if (type === 'facts') {
      const items = Array.isArray(block.factIds) ? block.factIds : [];
      return (
        <dl
          key={blockKey}
          className={`grid gap-x-5 gap-y-3 ${items.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}
        >
          {items.map((id) => {
            const item = fact(id);
            if (!item) return null;
            return (
              <div key={str(item.id)} className="min-w-0">
                <dt className={`break-words text-muted ${microLabelClass}`}>
                  {publicText(item.label) || 'Detail'}
                </dt>
                <dd className="mt-0.5 break-words text-sm font-medium text-strong [overflow-wrap:anywhere]">
                  {shownValue(item.id, 'text-sm font-medium')}
                </dd>
              </div>
            );
          })}
        </dl>
      );
    }
    if (type === 'score') {
      return (
        <div
          key={blockKey}
          className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-xl border border-edge/60 bg-raised/65 p-3 text-center"
        >
          <div>
            <p className="text-xs text-muted">{shownValue(block.leftLabelFact)}</p>
            <p className="mt-1 font-mono text-2xl font-semibold text-strong">
              {shownValue(block.leftValueFact, 'text-2xl font-semibold')}
            </p>
          </div>
          <div className="text-xs text-muted">
            <span>—</span>
            {block.statusFact ? <p className="mt-1">{shownValue(block.statusFact)}</p> : null}
          </div>
          <div>
            <p className="text-xs text-muted">{shownValue(block.rightLabelFact)}</p>
            <p className="mt-1 font-mono text-2xl font-semibold text-strong">
              {shownValue(block.rightValueFact, 'text-2xl font-semibold')}
            </p>
          </div>
        </div>
      );
    }
    if (type === 'code') {
      const item = fact(block.valueFact);
      if (!item) return null;
      const sensitive = sensitiveFact(item);
      const shown = revealed.has(revealKey(item.id)) || !sensitive;
      const name = publicText(item.label).toLowerCase() || 'code';
      if (!sensitive)
        return (
          <div
            key={blockKey}
            className="rounded-xl border border-dashed border-edge bg-sunken/45 px-4 py-3"
          >
            <p className={`break-words text-muted ${microLabelClass}`}>
              {publicText(item.label) || 'Code'}
            </p>
            <p className="mt-1 break-all font-mono text-sm font-semibold tracking-[0.08em] text-strong">
              {publicText(item.value)}
            </p>
            {block.format !== 'text' ? (
              <p className="mt-2 text-xs text-muted">
                The scannable code is available in the mobile app.
              </p>
            ) : null}
          </div>
        );
      return (
        <button
          key={blockKey}
          type="button"
          onClick={() => toggleReveal(item.id)}
          aria-pressed={sensitive ? shown : undefined}
          aria-label={sensitive ? `${shown ? 'Hide' : 'Show'} ${name}` : undefined}
          className={`rounded-xl border border-dashed border-edge bg-sunken/45 px-4 py-3 text-left ${focusRing}`}
        >
          <span className={`block break-words text-muted ${microLabelClass}`}>
            {shown ? str(block.format) : 'Tap to reveal'}
          </span>
          {/* One asterisk per character, in the face the value itself
                      uses, so revealing rewrites the line instead of resizing
                      it. */}
          <span className="mt-1 block break-all font-mono text-sm font-semibold tracking-[0.08em] text-strong">
            {shown ? str(item.value) : '*'.repeat(str(item.value).length)}
          </span>
        </button>
      );
    }
    if (type === 'note')
      return (
        <p key={blockKey} className="text-sm leading-6 text-muted">
          {shownValue(block.factId)}
        </p>
      );
    if (type === 'metrics') {
      return (
        <dl key={blockKey} className="grid grid-cols-2 gap-x-5 gap-y-3">
          {(block.factIds as string[]).map((id) => (
            <div key={id} className="min-w-0">
              <dt className="text-xs text-muted">{publicText(fact(id)?.label) || 'Metric'}</dt>
              <dd className="mt-1 break-words text-lg font-semibold tabular-nums text-strong">
                {shownValue(id)}
              </dd>
            </div>
          ))}
        </dl>
      );
    }
    if (type === 'journey') {
      return (
        <div key={blockKey} className="grid gap-3 border-y border-edge/60 py-3">
          <p className="text-xs text-muted">{publicText(block.mode)}</p>
          <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-3">
            <div className="min-w-0">
              <p className="text-xs text-muted">From</p>
              <p className="break-words font-semibold text-strong">{shownValue(block.fromFact)}</p>
              {block.departFact ? (
                <p className="mt-1 text-sm text-muted">{shownDateValue(block.departFact)}</p>
              ) : null}
            </div>
            <span aria-hidden="true" className="text-muted">
              →
            </span>
            <div className="min-w-0">
              <p className="text-xs text-muted">To</p>
              <p className="break-words font-semibold text-strong">{shownValue(block.toFact)}</p>
              {block.arriveFact ? (
                <p className="mt-1 text-sm text-muted">{shownDateValue(block.arriveFact)}</p>
              ) : null}
            </div>
          </div>
          {block.durationFact ? (
            <p className="text-sm text-muted">Duration: {shownValue(block.durationFact)}</p>
          ) : null}
          {block.statusFact ? (
            <p className="text-sm text-strong">{shownValue(block.statusFact)}</p>
          ) : null}
        </div>
      );
    }
    if (type === 'progress') {
      const raw = value(block.valueFact);
      const amount = numericValue(block.valueFact);
      const total = block.totalFact
        ? numericValue(block.totalFact)
        : raw.endsWith('%') && amount !== null
          ? 100
          : null;
      const valid =
        amount !== null && amount >= 0 && total !== null && total > 0 && amount <= total;
      return (
        <div key={blockKey} className="grid gap-2">
          {block.labelFact ? (
            <p className="text-sm font-medium text-strong">{shownValue(block.labelFact)}</p>
          ) : null}
          <p className="text-sm tabular-nums text-strong">
            {shownValue(block.valueFact)}
            {block.totalFact ? <> / {shownValue(block.totalFact)}</> : null}
          </p>
          {valid ? (
            <progress
              aria-label="Progress"
              value={amount}
              max={total}
              className="h-2 w-full appearance-none overflow-hidden rounded bg-sunken [&::-webkit-progress-bar]:bg-sunken [&::-webkit-progress-value]:bg-accent [&::-moz-progress-bar]:bg-accent"
            />
          ) : (
            <p className="text-xs text-muted">Progress unknown</p>
          )}
        </div>
      );
    }
    if (type === 'stages') {
      const current = value(block.currentFact);
      const currentVisible =
        !sensitiveFact(fact(block.currentFact)) || revealed.has(revealKey(block.currentFact));
      return (
        <div key={blockKey} className="grid gap-2">
          <p className="text-sm text-muted">Current stage: {shownValue(block.currentFact)}</p>
          <ol className="grid gap-2 border-l border-edge pl-4">
            {(block.factIds as string[]).map((id) => (
              <li
                key={id}
                aria-current={
                  currentVisible &&
                  (!sensitiveFact(fact(id)) || revealed.has(revealKey(id))) &&
                  (id === current || value(id) === current)
                    ? 'step'
                    : undefined
                }
                className="text-sm text-strong"
              >
                {shownValue(id)}
              </li>
            ))}
          </ol>
        </div>
      );
    }
    if (type === 'countdown') {
      const privateDate =
        sensitiveFact(fact(block.dateFact)) && !revealed.has(revealKey(block.dateFact));
      const dateText = value(block.dateFact);
      // Keep the actual date visible; avoid hydration drift from Date.now() or
      // inventing a timezone for a date-only/ambiguous source value.
      const known =
        !privateDate &&
        /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(dateText) &&
        Number.isFinite(Date.parse(dateText));
      return (
        <div key={blockKey} className="grid gap-1 border-l-2 border-accent/50 pl-3">
          {block.labelFact ? (
            <p className="text-xs text-muted">{shownValue(block.labelFact)}</p>
          ) : null}
          <p className="text-sm font-semibold text-strong">{shownDateValue(block.dateFact)}</p>
          <p className="text-xs text-muted">
            {known && now !== null
              ? `${Date.parse(dateText) >= now ? 'In ' : ''}${Math.ceil(Math.abs(Date.parse(dateText) - now) / 60_000).toLocaleString()} minutes${Date.parse(dateText) < now ? ' ago' : ''}`
              : known
                ? `Scheduled ${shortDate(dateText, timeZone)}`
                : 'Countdown unknown'}
          </p>
        </div>
      );
    }
    if (type === 'table') {
      return (
        <div key={blockKey} className="overflow-x-auto">
          <table
            aria-label={publicText(spec.title)}
            className="w-full border-collapse text-left text-sm"
          >
            <thead>
              <tr>
                {(block.columns as string[]).map((label, index) => (
                  <th
                    // biome-ignore lint/suspicious/noArrayIndexKey: column labels may repeat; cells have no component state.
                    key={`${index}-${label}`}
                    scope="col"
                    className="border-b border-edge py-2 pr-4 font-medium text-muted"
                  >
                    {publicText(label)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(block.rows as string[][]).map((cells, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: repeated table rows are valid; rows have no component state.
                <tr key={`${index}-${cells.join(',')}`}>
                  {cells.map((id, column) => (
                    <td
                      // biome-ignore lint/suspicious/noArrayIndexKey: repeated fact references in separate columns are valid.
                      key={`${column}-${id}`}
                      className="border-b border-edge/50 py-2 pr-4 align-top text-strong"
                    >
                      {shownValue(id)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    if (type === 'chart') {
      const points = recs(block.points);
      const values = points.map((point) => numericValue(point.valueFact));
      const known = values.filter((n): n is number => n !== null);
      const low = Math.min(0, ...known);
      const high = Math.max(0, ...known);
      const scale = Math.max(Math.abs(low), Math.abs(high)) || 1;
      const range = high / scale - low / scale || 1;
      const y = (n: number) => 90 - ((n / scale - low / scale) / range) * 80;
      const baseline = y(0);
      const complete = values.every((n) => n !== null);
      return (
        <figure key={blockKey} className="grid gap-3">
          {known.length > 0 ? (
            <svg
              viewBox="0 0 300 100"
              role="img"
              aria-label={`${str(block.kind) === 'line' ? 'Line' : 'Bar'} chart. Values listed below.`}
              className="h-28 w-full text-accent"
            >
              <line
                x1="0"
                x2="300"
                y1={baseline}
                y2={baseline}
                stroke="currentColor"
                opacity="0.25"
              />
              {str(block.kind) === 'line'
                ? points.map((point, index) => {
                    const n = values[index];
                    const previous = index ? values[index - 1] : null;
                    if (n === null || n === undefined) return null;
                    const x = 10 + (index / (points.length - 1)) * 280;
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: repeated labels are valid ordered samples; marks are stateless.
                      <g key={`${index}-${str(point.labelFact)}`}>
                        {previous !== null && previous !== undefined ? (
                          <line
                            x1={10 + ((index - 1) / (points.length - 1)) * 280}
                            x2={x}
                            y1={y(previous)}
                            y2={y(n)}
                            stroke="currentColor"
                            strokeWidth="2"
                          />
                        ) : null}
                        <circle cx={x} cy={y(n)} r="3" fill="currentColor" />
                      </g>
                    );
                  })
                : points.map((point, index) => {
                    const n = values[index];
                    if (n === null || n === undefined) return null;
                    return (
                      <rect
                        // biome-ignore lint/suspicious/noArrayIndexKey: repeated labels are valid ordered samples; marks are stateless.
                        key={`${index}-${str(point.labelFact)}`}
                        x={(index / points.length) * 300 + 5}
                        y={Math.min(y(n), baseline)}
                        width={300 / points.length - 10}
                        height={Math.abs(y(n) - baseline)}
                        rx="2"
                        fill="currentColor"
                      />
                    );
                  })}
            </svg>
          ) : null}
          {!complete ? (
            <p className="text-xs text-muted">Some chart values are unknown or private.</p>
          ) : null}
          <dl className="grid gap-1">
            {points.map((point, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: repeated labels are valid ordered samples; entries are stateless.
                key={`${index}-${str(point.labelFact)}`}
                className="flex justify-between gap-4 text-sm"
              >
                <dt className="text-muted">{shownValue(point.labelFact)}</dt>
                <dd className="font-medium tabular-nums text-strong">
                  {shownValue(point.valueFact)}
                </dd>
              </div>
            ))}
          </dl>
        </figure>
      );
    }
    if (type === 'checklist') {
      return (
        <ul key={blockKey} aria-label="Personal checklist" className="grid gap-2">
          {(block.factIds as string[]).map((id) => {
            const key = `${blockKey}:${revealKey(id)}`;
            return (
              <li key={id} className="flex items-start gap-2 text-sm text-strong">
                <input
                  type="checkbox"
                  aria-label={`Mark ${publicText(fact(id)?.label) || 'item'} complete`}
                  checked={checked.has(key)}
                  onChange={() =>
                    setChecked((current) => {
                      const next = new Set(current);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                  className={`mt-1 shrink-0 accent-accent ${focusRing}`}
                />
                <span>{shownValue(id)}</span>
              </li>
            );
          })}
        </ul>
      );
    }
    if (type === 'map') {
      return (
        <div key={blockKey} className="grid gap-2">
          <p className="text-xs text-muted">
            Open a place to view its map. The full map is available in the mobile app.
          </p>
          <ul className="grid gap-2">
            {(block.placeFactIds as string[]).map((id) => {
              const hidden = sensitiveFact(fact(id)) && !revealed.has(revealKey(id));
              return (
                <li key={id} className="flex flex-wrap items-center gap-2 text-sm text-strong">
                  <MapPin className="size-4 text-accent" aria-hidden="true" />
                  {shownValue(id)}
                  {!hidden ? (
                    <CardLink
                      href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(value(id))}`}
                      label="Open map"
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      );
    }
    if (type === 'image') {
      const urlFact = fact(block.urlFact);
      const altFact = fact(block.altFact);
      const privateImage = sensitiveFact(urlFact) || sensitiveFact(altFact);
      const src = privateImage ? '' : cardHref(value(block.urlFact));
      return src ? (
        <Image
          key={blockKey}
          src={`/api/card-image?url=${encodeURIComponent(src)}`}
          alt={publicText(value(block.altFact))}
          className="max-h-64 w-full rounded-xl border border-edge/60 object-cover"
          width={1200}
          height={640}
          unoptimized
        />
      ) : privateImage ? (
        <p key={blockKey} className="text-xs text-muted">
          Image withheld because its source or description is private.
        </p>
      ) : null;
    }
    return null;
  };

  return (
    <section
      aria-label={publicText(spec.accessibilityLabel) || publicText(spec.title) || 'Response card'}
      data-response-card="true"
      className="paper relative min-w-0 w-full overflow-hidden rounded-[var(--radius-card)] border border-edge/70 bg-raised"
    >
      <div className="relative px-4 py-4 sm:px-5">
        <header className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] items-start gap-3">
          <Icon className="mt-1 size-4 shrink-0 stroke-[1.75] text-accent" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-xs leading-5 font-medium text-muted">
              {publicText(spec.sourceLabel)}
            </p>
            <h3 className="text-base leading-6 font-semibold text-strong">
              {publicText(spec.title)}
            </h3>
            {publicText(spec.subtitle) ? (
              <p className="text-sm leading-5 text-muted">{publicText(spec.subtitle)}</p>
            ) : null}
          </div>
        </header>

        {str(data.updatedAt) ||
        data.stale === true ||
        (!onRefresh && refreshing) ||
        (!refreshing && data.refreshState === 'failed') ? (
          <div
            className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted"
            role="status"
            aria-live="polite"
          >
            {str(data.updatedAt) ? (
              <span>Updated {shortDate(str(data.updatedAt), timeZone)}</span>
            ) : null}
            {refreshing && !onRefresh ? (
              <span className="inline-flex items-center gap-1 text-accent">
                <RotateCw className="size-3 motion-safe:animate-spin" aria-hidden="true" />
                Refreshing…
              </span>
            ) : !refreshing && data.refreshState === 'failed' ? (
              <span>Refresh failed. Showing the saved version.</span>
            ) : data.stale === true ? (
              <span className="inline-flex items-center gap-1">
                <Clock className="size-3" aria-hidden="true" />
                May be out of date
              </span>
            ) : null}
          </div>
        ) : null}

        <div className="mt-3 grid gap-3">
          {previewBlocks.map((block) => renderBlock(block))}
          {detailBlocks.length > 0 ? (
            <details className="border-t border-edge/60 pt-2.5">
              <summary
                className={`disclosure flex cursor-pointer items-center gap-2 rounded-sm text-xs font-medium text-muted ${focusRing}`}
              >
                More details
              </summary>
              <div className="mt-3 grid gap-3">
                {detailBlocks.map((block) => renderBlock(block))}
              </div>
            </details>
          ) : null}
        </div>

        {actions.length > 0 || (refreshable && onRefresh) ? (
          <div className="mt-4 flex flex-wrap gap-2 border-t border-edge/60 pt-3">
            {refreshable && onRefresh ? (
              <button
                type="button"
                disabled={refreshing}
                onClick={() => void refresh()}
                className={`${chip.accent.replace('disabled:opacity-50', '')} disabled:cursor-wait`}
              >
                <RotateCw
                  className={`size-3 ${refreshing ? 'motion-safe:animate-spin' : ''}`}
                  aria-hidden="true"
                />
                {refreshAttempt?.state === 'saving' && refreshing
                  ? 'Starting refresh…'
                  : refreshing
                    ? 'Refreshing…'
                    : 'Refresh'}
              </button>
            ) : null}
            {actions.map((action) => {
              const type = str(action.type);
              const id = str(action.id);
              const target = fact(action.factId);
              if (type === 'open_url' && target && cardHref(target.value)) {
                if (sensitiveFact(target) && !revealed.has(revealKey(target.id))) {
                  return (
                    <button
                      key={id}
                      type="button"
                      className={chip.neutral}
                      onClick={() => toggleReveal(target.id)}
                    >
                      Reveal {publicText(action.label) || 'private link'}
                    </button>
                  );
                }
                return (
                  <CardLink
                    key={id}
                    href={cardHref(target.value)}
                    label={publicText(action.label)}
                  />
                );
              }
              if (
                type === 'open_url' ||
                ((type === 'copy_value' || type === 'reveal_sensitive') && !target) ||
                (type === 'ask_assistant' && (!str(action.prompt) || !onSend)) ||
                !['copy_value', 'reveal_sensitive', 'ask_assistant'].includes(type)
              )
                return null;
              return (
                <button
                  key={id}
                  type="button"
                  className={chip.neutral}
                  onClick={() => {
                    if (type === 'copy_value' && target) {
                      if (sensitiveFact(target) && !revealed.has(revealKey(target.id)))
                        toggleReveal(target.id);
                      else void copyValue(str(target.value));
                    }
                    if (type === 'reveal_sensitive' && target) toggleReveal(target.id);
                    if (type === 'ask_assistant' && str(action.prompt) && onSend)
                      onSend(str(action.prompt));
                  }}
                >
                  {type === 'ask_assistant' ? (
                    <MessageCircle className="size-3" aria-hidden="true" />
                  ) : null}
                  {type === 'copy_value' &&
                  target &&
                  sensitiveFact(target) &&
                  !revealed.has(revealKey(target.id))
                    ? `Reveal to copy ${publicText(target.label) || 'private value'}`
                    : publicText(action.label)}
                </button>
              );
            })}
            {actions.some((action) =>
              ['add_to_calendar', 'directions'].includes(str(action.type)),
            ) ? (
              <p className="w-full text-xs text-muted">
                Some actions are available in the mobile app.
              </p>
            ) : null}
            {actions.some(
              (action) =>
                ![
                  'open_url',
                  'copy_value',
                  'reveal_sensitive',
                  'ask_assistant',
                  'add_to_calendar',
                  'directions',
                ].includes(str(action.type)),
            ) ? (
              <p className="w-full text-xs text-muted">
                Some actions are unavailable in this version of the app.
              </p>
            ) : null}
          </div>
        ) : null}
        {actionFeedback ? (
          <p role="status" className="mt-2 text-xs text-muted">
            {actionFeedback}
          </p>
        ) : null}
        {/* Last element in the card, after the actions: the answer first, then
            the affordances that act on it, then — for whoever wants it — where
            it came from. */}
        <CardSteps steps={cardStepsOf(data.steps)} />
      </div>
    </section>
  );
}

function ResponseCardView({
  data,
  timeZone,
  conversationId,
  formSessionScope,
  formDraft,
  formError,
  onChangeForm,
  onReviewForm,
  onCarryForm,
  onDiscardForm,
  onSend,
  onRefresh,
}: {
  data: Raw;
  timeZone: string;
  conversationId?: string;
  formSessionScope?: string;
  formDraft?: CardFormDraft | null;
  formError?: string | null;
  onChangeForm?: (identity: CardFormIdentity, form: CardForm, values: CardFormValues) => void;
  onReviewForm?: (identity: CardFormIdentity, form: CardForm, values: CardFormValues) => void;
  onCarryForm?: (identity: CardFormIdentity, form: CardForm) => void;
  onDiscardForm?: (identity: CardFormIdentity) => void;
  onSend?: (text: string) => void;
  onRefresh?: RefreshCard;
}) {
  switch (data.kind) {
    case 'calendar-day':
      return <CalendarDayCard data={data} timeZone={timeZone} />;
    case 'calendar':
    case 'agenda':
      return <AgendaCard data={data} />;
    case 'weather':
      return <WeatherCard data={data} />;
    case 'briefing':
      return <BriefingCard data={data} />;
    case 'route':
      return (
        <CardShell icon={MapPin} label="Directions">
          <RouteCard data={data} timeZone={timeZone} />
        </CardShell>
      );
    case 'scoreboard':
      return (
        <CardShell icon={Trophy} label={str(data.title) || 'Scores'}>
          <ScoreboardCard data={data} />
        </CardShell>
      );
    case 'calendar-event':
      return <CalendarEventCard data={data} />;
    case 'email-results':
      return <EmailResultsCard data={data} timeZone={timeZone} />;
    case 'email-thread':
      return <EmailThreadCard data={data} timeZone={timeZone} />;
    case 'sheet-rows':
      return <SheetRowsCard data={data} />;
    case 'resource':
      return <ResourceCard data={data} />;
    case 'web-search-results':
      return <WebSearchCard data={data} />;
    case 'availability':
      return <AvailabilityCard data={data} timeZone={timeZone} />;
    case 'status':
      return <StatusCard data={data} />;
    case 'reminder':
      return <ReminderCard data={data} />;
    case 'drive-results':
      return <DriveResultsCard data={data} timeZone={timeZone} />;
    case 'document-results':
      return <DocumentResultsCard data={data} />;
    case 'knowledge-graph':
      return <KnowledgeGraphCard data={data} />;
    case 'calendar-conflicts':
      return <CalendarConflictsCard data={data} timeZone={timeZone} />;
    case 'proactive-alert':
      return <ProactiveAlertCard data={data} timeZone={timeZone} />;
    case 'generated-card':
      return (
        <GeneratedCard
          data={data}
          conversationId={conversationId}
          formSessionScope={formSessionScope}
          formDraft={formDraft}
          formError={formError}
          onChangeForm={onChangeForm}
          onReviewForm={onReviewForm}
          onCarryForm={onCarryForm}
          onDiscardForm={onDiscardForm}
          onSend={onSend}
          onRefresh={onRefresh}
          timeZone={timeZone}
        />
      );
    default:
      // Newer card kinds keep their prose fallback until this client supports them.
      return null;
  }
}

/**
 * The cards one assistant message carries, in order. Kinds this surface does
 * not render return null, and the caller keeps the prose bubble for them.
 */
export function responseCardPayloads(parts: unknown[]): Raw[] {
  const out: Raw[] = [];
  for (const part of parts) {
    const parsed = rec(part);
    if (parsed?.type !== 'data-card') continue;
    const data = rec(parsed.data);
    if (data?.kind === 'drive-results' && recs(data.files).length === 0) continue;
    if (data) out.push(data);
  }
  if (out.length > 0) return out;
  const text = parts
    .map(rec)
    .filter((part): part is Raw => part?.type === 'text')
    .map((part) => str(part.text))
    .join('')
    .trim();
  return legacyTextCards(text);
}

function legacyTextCards(text: string): Raw[] {
  if (!text) return [];
  const alert = /^"([^"]{1,120})" starts in (\d{1,3}) minutes?(?: at (.*?))?\.\s+/i.exec(text);
  if (alert?.[1] && alert[2]) {
    const location = str(alert[3]);
    return [
      {
        kind: 'proactive-alert',
        id: `legacy-event-${alert[1]}-${alert[2]}`,
        category: 'event',
        urgencyLabel: `Starts in ${alert[2]} min`,
        title: alert[1],
        details: location ? [{ label: 'Location', value: location }] : [],
      },
    ];
  }

  const chunks = text.split(/\s+(?=\d+\)\s)/).filter((chunk) => /^\d+\)\s/.test(chunk));
  if (chunks.length < 2) return [];
  const clock = String.raw`\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?`;
  const items = chunks.map((chunk, index) => {
    const value = chunk.replace(/^\d+\)\s*/, '').replace(/\s+$/, '');
    const ranged = new RegExp(
      `^(.*?)\\s+from\\s+(${clock}\\s*[–-]\\s*${clock})(?:\\s+at\\s+(.+?))?\\.?$`,
      'i',
    ).exec(value);
    const single = new RegExp(`^(.*?)\\s+at\\s+(${clock})(?:\\s+at\\s+(.+?))?\\.?$`, 'i').exec(
      value,
    );
    const match = ranged ?? single;
    if (!match?.[1] || !match[2]) return null;
    return {
      id: `legacy-agenda-${index.toString()}`,
      time: match[2].trim().replace(/\.$/, '').toUpperCase(),
      title: match[1].trim(),
      detail: (match[3] ?? '').replace(/\.$/, '').trim(),
    };
  });
  if (items.some((item) => item === null)) return [];
  const lead = text.slice(0, text.indexOf('1)')).trim().replace(/:$/, '');
  return [
    {
      kind: 'agenda',
      id: `legacy-agenda-${items.length.toString()}`,
      title: /tomorrow/i.test(lead) ? 'Tomorrow' : 'Your schedule',
      subtitle: `${items.length.toString()} upcoming events`,
      items,
    },
  ];
}

/**
 * Whether these cards stand in for the reply or merely head it.
 *
 * A card grounded in a lookup carries the answer, so prose beside it would
 * only repeat it. A card the composer read out of the reply itself redraws
 * part of an answer that also explains the route, the caveats and when to
 * leave — replacing the reply with it would delete the rest of the answer.
 */
export function cardsReplaceProse(cards: Raw[]): boolean {
  const containsForm = (blocks: unknown[]): boolean =>
    blocks.some((value) => {
      const block = rec(value);
      return (
        !!block &&
        (block.type === 'form' || (block.type === 'section' && containsForm(recs(block.blocks))))
      );
    });
  if (cards.some((card) => containsForm(recs(rec(card.spec)?.blocks)))) return false;
  // Prose may carry context that no card redraws. Replace it only when every
  // card is grounded in lookup evidence; one answer-derived/accompanying card
  // means the message still has wording to preserve.
  return (
    cards.length > 0 &&
    cards.every(
      (card) =>
        !['answer', 'message'].includes(str(card.grounding)) && card.accompaniesProse !== true,
    )
  );
}

export interface CardCapabilityContext {
  /** `ask_assistant` is only represented when this message can submit it. */
  onSendAvailable?: boolean;
  /** Form blocks are full only when the ordinary owner composer path is wired. */
  onCardFormReviewAvailable?: boolean;
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasFact(facts: Map<string, Raw>, id: unknown): boolean {
  const fact = facts.get(str(id));
  return !!fact && hasText(fact.value);
}

function generatedCardCapability(
  card: Raw,
  context: CardCapabilityContext,
): { shell: boolean; full: boolean } {
  const spec = rec(card.spec);
  if (spec?.version !== 1 || !hasText(spec.title)) return { shell: false, full: false };
  const facts = new Map(recs(spec.facts).map((fact) => [str(fact.id), fact]));
  const capability = generatedSpecBlockCapability(spec, 'web', {
    formRendererAvailable:
      context.onCardFormReviewAvailable === true &&
      UUID_IDENTITY.test(str(card.id)) &&
      UUID_IDENTITY.test(str(card.revisionId)),
  });
  if (!capability.shell) return { shell: false, full: false };
  const blocksFullySupported = capability.full;
  const actions = recs(spec.actions).filter((action) => str(action.type) !== 'refresh');
  const actionsSupported =
    (spec.actions === undefined ||
      (Array.isArray(spec.actions) &&
        spec.actions.length <= 6 &&
        spec.actions.every((action) => !!rec(action)))) &&
    actions.every((action) => {
      const type = str(action.type);
      if (type === 'ask_assistant')
        return hasText(action.prompt) && context.onSendAvailable === true;
      if (['open_url', 'copy_value', 'reveal_sensitive'].includes(type)) {
        if (!hasFact(facts, action.factId)) return false;
        return type !== 'open_url' || cardHref(facts.get(str(action.factId))?.value) !== '';
      }
      // These actions remain visible as an explicit mobile-app fallback.
      return type === 'add_to_calendar' || type === 'directions';
    });
  return { shell: true, full: blocksFullySupported && actionsSupported };
}

function rows(value: unknown, valid: (row: unknown) => boolean): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(valid);
}

function hasValidRow(value: unknown, valid: (row: unknown) => boolean): boolean {
  return Array.isArray(value) && value.some(valid);
}

function validDateText(value: unknown): boolean {
  return hasText(value) && Number.isFinite(Date.parse(str(value)));
}

function validOptionalArray(card: Raw, key: string, valid: (row: unknown) => boolean): boolean {
  if (!Object.hasOwn(card, key)) return true;
  return Array.isArray(card[key]) && card[key].every(valid);
}

function validAgendaItem(value: unknown, withDay = false): boolean {
  const item = rec(value);
  return !!item && (!withDay || hasText(item.day)) && hasText(item.time) && hasText(item.title);
}

function validBriefingItem(value: unknown): boolean {
  const item = rec(value);
  return !!item && (hasText(item.title) || hasText(item.detail) || hasText(item.meta));
}

function validWeatherDetail(value: unknown): boolean {
  const detail = rec(value);
  return !!detail && hasText(detail.label) && hasText(detail.value);
}

function validWeatherDay(value: unknown): boolean {
  const day = rec(value);
  return (
    !!day && hasText(day.weekday) && num(day.lowC) !== undefined && num(day.highC) !== undefined
  );
}

function validBriefingSection(value: unknown): boolean {
  const section = rec(value);
  if (!section || !hasText(section.title)) return false;
  if (section.type === 'agenda') return rows(section.items, (item) => validAgendaItem(item, true));
  if (section.type === 'weather')
    return hasText(section.temperature) || hasText(section.condition) || hasText(section.range);
  if (['attention', 'mail', 'upcoming', 'goals', 'watches'].includes(str(section.type)))
    return rows(section.items, validBriefingItem);
  // Unknown section variants use the text-list fallback today, but cannot be
  // claimed complete until the producer and renderer share a named contract.
  return false;
}

function validEvent(value: unknown): boolean {
  const event = rec(value);
  const start = Date.parse(str(event?.start));
  const end = event && hasText(event.end) ? Date.parse(str(event.end)) : undefined;
  return (
    !!event &&
    hasText(event.title) &&
    hasText(event.start) &&
    Number.isFinite(start) &&
    (end === undefined || (Number.isFinite(end) && end > start)) &&
    validOptionalArray(event, 'calendars', hasText)
  );
}

function validEmailResult(value: unknown): boolean {
  const message = rec(value);
  return (
    !!message &&
    (hasText(message.sender) || hasText(message.subject) || hasText(message.snippet)) &&
    (!hasText(message.date) || validDateText(message.date))
  );
}

function validEmailThreadMessage(value: unknown): boolean {
  const message = rec(value);
  return (
    !!message &&
    (hasText(message.sender) || hasText(message.excerpt)) &&
    (!hasText(message.date) || validDateText(message.date))
  );
}

function validSheetRow(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.some(
      (cell) => typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean',
    )
  );
}

function validSearchResult(value: unknown): boolean {
  const result = rec(value);
  return !!result && (hasText(result.title) || hasText(result.snippet) || hasText(result.url));
}

function validDriveFile(value: unknown): boolean {
  const file = rec(value);
  return (
    !!file &&
    (hasText(file.name) || hasText(file.url)) &&
    (!hasText(file.modifiedTime) || validDateText(file.modifiedTime))
  );
}

function validDocumentPassage(value: unknown): boolean {
  const passage = rec(value);
  return !!passage && (hasText(passage.document) || hasText(passage.snippet));
}

function validGraphEdge(value: unknown, nodes: Map<string, Raw>): boolean {
  const edge = rec(value);
  if (!edge) return false;
  const from = nodes.get(str(edge.from));
  const to = nodes.get(str(edge.to));
  const fromLabel = hasText(edge.fromLabel) || hasText(from?.label);
  const toLabel = hasText(edge.toLabel) || hasText(to?.label);
  return fromLabel && toLabel && (hasText(edge.label) || hasText(edge.evidenceQuote));
}

function validConflict(value: unknown): boolean {
  const conflict = rec(value);
  if (!conflict) return false;
  const start = Date.parse(str(conflict.overlapStart));
  const end = Date.parse(str(conflict.overlapEnd));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
  return (
    rows(conflict.groups, (groupValue) => {
      const group = rec(groupValue);
      return !!group && rows(group.events, (event) => validEvent(event));
    }) && recs(conflict.groups).length >= 2
  );
}

function validRouteStep(value: unknown): boolean {
  const step = rec(value);
  return (
    !!step &&
    hasText(step.instruction) &&
    (!Object.hasOwn(step, 'distanceMeters') ||
      (typeof step.distanceMeters === 'number' &&
        Number.isFinite(step.distanceMeters) &&
        step.distanceMeters >= 0))
  );
}

function validScoreGame(value: unknown): boolean {
  const game = rec(value);
  if (!game || !hasText(game.id) || !['pre', 'in', 'post'].includes(str(game.state))) return false;
  const home = rec(game.home);
  const away = rec(game.away);
  return (
    !!home &&
    !!away &&
    hasText(home.name) &&
    hasText(away.name) &&
    (!hasText(game.startsAt) || validDateText(game.startsAt))
  );
}

function specializedCardSupported(card: Raw): boolean {
  const kind = str(card.kind);
  if (kind === 'generated-card') return false;
  if (kind === 'route') {
    const validMetric = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const origin = rec(card.origin);
    const destination = rec(card.destination);
    const mapsUrl = str(card.mapsUrl);
    return (
      validMetric(card.durationSeconds) &&
      validMetric(card.distanceMeters) &&
      hasText(destination?.label) &&
      (origin?.current === true || hasText(origin?.label)) &&
      ['driving', 'walking', 'cycling', ''].includes(str(card.mode)) &&
      validOptionalArray(card, 'steps', validRouteStep) &&
      (!hasText(card.departAt) || validDateText(card.departAt)) &&
      (!hasText(card.arriveAt) || validDateText(card.arriveAt)) &&
      (!mapsUrl || /^https:\/\/maps\.apple\.com\//.test(mapsUrl))
    );
  }
  if (kind === 'scoreboard') return rows(card.games, validScoreGame);
  if (kind === 'weather') {
    const details = Array.isArray(card.details) ? card.details : [];
    const days = Array.isArray(card.days) ? card.days : [];
    const visible =
      hasText(card.temperature) ||
      hasText(card.condition) ||
      hasValidRow(details, validWeatherDetail) ||
      hasValidRow(days, validWeatherDay);
    return (
      visible &&
      validOptionalArray(card, 'details', validWeatherDetail) &&
      validOptionalArray(card, 'days', validWeatherDay)
    );
  }
  if (kind === 'calendar' || kind === 'agenda')
    return rows(card.items, (item) => validAgendaItem(item));
  if (kind === 'calendar-day') return rows(card.events, validEvent);
  if (kind === 'briefing') {
    const sectionsValid = validOptionalArray(card, 'sections', validBriefingSection);
    const hasSections = rows(card.sections, validBriefingSection);
    return (hasText(card.lead) || hasSections) && sectionsValid;
  }
  if (kind === 'calendar-event')
    return (
      validEvent(card) &&
      (!Object.hasOwn(card, 'calendarLink') || !!link(card.calendarLink)) &&
      (!Object.hasOwn(card, 'meetingLink') || !!link(card.meetingLink)) &&
      validOptionalArray(card, 'attendees', hasText)
    );
  if (kind === 'email-results') return rows(card.messages, validEmailResult);
  if (kind === 'email-thread') {
    const count = card.messageCount;
    return (
      rows(card.messages, validEmailThreadMessage) &&
      (count === undefined ||
        (Number.isSafeInteger(count) && (count as number) >= recs(card.messages).length))
    );
  }
  if (kind === 'sheet-rows') {
    const rowsValid = rows(card.rows, validSheetRow);
    const columns = Array.isArray(card.rows)
      ? Math.max(0, ...card.rows.filter(Array.isArray).map((row) => row.length))
      : 0;
    const totalRows = card.totalRows;
    return (
      rowsValid &&
      columns > 0 &&
      (totalRows === undefined ||
        (Number.isSafeInteger(totalRows) && (totalRows as number) >= recs(card.rows).length)) &&
      (!Object.hasOwn(card, 'link') || !!link(card.link))
    );
  }
  if (kind === 'resource') {
    const detailsValid = validOptionalArray(card, 'details', validWeatherDetail);
    const steps = cardStepsOf(card.steps);
    const stepsValid = validOptionalArray(
      card,
      'steps',
      (step) => !!rec(step) && hasText(rec(step)?.tool),
    );
    const resourceType = str(card.resourceType);
    return (
      (hasText(card.title) ||
        hasText(card.name) ||
        hasText(card.subtitle) ||
        pairs(card.details).length > 0 ||
        !!link(card.link) ||
        steps.length > 0) &&
      detailsValid &&
      stepsValid &&
      (!Object.hasOwn(card, 'link') || !!link(card.link)) &&
      (!resourceType || ['document', 'spreadsheet'].includes(resourceType))
    );
  }
  if (kind === 'web-search-results') return rows(card.results, validSearchResult);
  if (kind === 'availability') {
    const rows = Array.isArray(card.busy) ? card.busy : [];
    const checked = strs(card.calendarsChecked);
    return (
      card.complete === true &&
      validOptionalArray(card, 'calendarsChecked', hasText) &&
      (rows.length > 0 || checked.length > 0) &&
      rows.every((row) => {
        const slot = rec(row);
        const start = Date.parse(str(slot?.start));
        const end = Date.parse(str(slot?.end));
        return Number.isFinite(start) && Number.isFinite(end) && end > start;
      })
    );
  }
  if (kind === 'status')
    return (
      (hasText(card.title) ||
        hasText(card.detail) ||
        pairs(card.details).length > 0 ||
        !!link(card.link)) &&
      validOptionalArray(card, 'details', validWeatherDetail) &&
      (!Object.hasOwn(card, 'link') || !!link(card.link))
    );
  if (kind === 'reminder')
    return hasText(card.title) || hasText(card.nextFires) || hasText(card.schedule);
  if (kind === 'drive-results') return rows(card.files, validDriveFile);
  if (kind === 'document-results') return rows(card.passages, validDocumentPassage);
  if (kind === 'knowledge-graph') {
    const nodes = new Map(recs(card.nodes).map((node) => [str(node.id), node]));
    return (
      rows(card.edges, (edge) => validGraphEdge(edge, nodes)) &&
      validOptionalArray(
        card,
        'nodes',
        (node) => !!rec(node) && hasText(rec(node)?.id) && hasText(rec(node)?.label),
      )
    );
  }
  if (kind === 'calendar-conflicts') return rows(card.conflicts, validConflict);
  if (kind === 'proactive-alert')
    return (
      hasText(card.title) &&
      validOptionalArray(card, 'details', validWeatherDetail) &&
      (!hasText(card.startsAt) || validDateText(card.startsAt)) &&
      (!hasText(card.dueAt) || validDateText(card.dueAt))
    );
  return false;
}

function specializedCardHasVisibleContent(card: Raw): boolean {
  const kind = str(card.kind);
  if (kind === 'availability') return true;
  if (kind === 'route') {
    const destination = rec(card.destination);
    const steps = Array.isArray(card.steps) ? card.steps.filter(validRouteStep) : [];
    return (
      hasText(destination?.label) ||
      (typeof card.durationSeconds === 'number' && Number.isFinite(card.durationSeconds)) ||
      (typeof card.distanceMeters === 'number' && Number.isFinite(card.distanceMeters)) ||
      steps.length > 0 ||
      /^https:\/\/maps\.apple\.com\//.test(str(card.mapsUrl))
    );
  }
  if (kind === 'weather')
    return (
      hasText(card.temperature) ||
      hasText(card.condition) ||
      hasValidRow(card.details, validWeatherDetail) ||
      hasValidRow(card.days, validWeatherDay)
    );
  if (kind === 'scoreboard') return hasValidRow(card.games, validScoreGame);
  if (kind === 'calendar' || kind === 'agenda')
    return hasValidRow(card.items, (item) => validAgendaItem(item));
  if (kind === 'calendar-day') return hasValidRow(card.events, validEvent);
  if (kind === 'briefing')
    return (
      hasText(card.lead) ||
      hasValidRow(card.sections, (section) => {
        const row = rec(section);
        return !!row && (hasText(row.title) || hasValidRow(row.items, validBriefingItem));
      })
    );
  if (kind === 'email-results')
    return hasValidRow(card.messages, validEmailResult) || card.complete === false;
  if (kind === 'email-thread')
    return hasText(card.subject) || hasValidRow(card.messages, validEmailThreadMessage);
  if (kind === 'sheet-rows') return hasValidRow(card.rows, validSheetRow);
  if (kind === 'resource')
    return (
      hasText(card.title) ||
      hasText(card.name) ||
      hasText(card.subtitle) ||
      pairs(card.details).length > 0 ||
      !!link(card.link)
    );
  if (kind === 'web-search-results') return hasValidRow(card.results, validSearchResult);
  if (kind === 'availability') return true;
  if (kind === 'status')
    return (
      hasText(card.title) ||
      hasText(card.detail) ||
      pairs(card.details).length > 0 ||
      !!link(card.link)
    );
  if (kind === 'reminder')
    return hasText(card.title) || hasText(card.nextFires) || hasText(card.schedule);
  if (kind === 'drive-results') return hasValidRow(card.files, validDriveFile);
  if (kind === 'document-results') return hasValidRow(card.passages, validDocumentPassage);
  if (kind === 'knowledge-graph') {
    const nodes = new Map(recs(card.nodes).map((node) => [str(node.id), node]));
    return hasValidRow(card.edges, (edge) => {
      const row = rec(edge);
      return !!row && (validGraphEdge(row, nodes) || hasText(row.evidenceQuote));
    });
  }
  if (kind === 'calendar-conflicts') return hasValidRow(card.conflicts, validConflict);
  if (kind === 'proactive-alert') return hasText(card.title) || pairs(card.details).length > 0;
  if (kind === 'calendar-event') return validEvent(card);
  return specializedCardSupported(card);
}

/** True when every card on the message is fully represented on this surface. */
export function rendersAllCards(cards: Raw[], context: CardCapabilityContext = {}): boolean {
  return (
    cards.length > 0 &&
    cards.every((card) => {
      if (str(card.kind) === 'generated-card') return generatedCardCapability(card, context).full;
      return specializedCardSupported(card);
    })
  );
}

/** True when at least one card can be drawn, including a partial generated v1 card. */
export function rendersSomeCards(cards: Raw[], context: CardCapabilityContext = {}): boolean {
  return cards.some((card) =>
    str(card.kind) === 'generated-card'
      ? generatedCardCapability(card, context).shell
      : specializedCardHasVisibleContent(card),
  );
}

export function ResponseCards({
  cards,
  timeZone,
  conversationId,
  formSessionScope,
  formDraft,
  formError,
  onChangeForm,
  onReviewForm,
  onCarryForm,
  onDiscardForm,
  onSend,
  onRefresh,
}: {
  cards: Raw[];
  timeZone: string;
  conversationId?: string;
  formSessionScope?: string;
  formDraft?: CardFormDraft | null;
  formError?: string | null;
  onChangeForm?: (identity: CardFormIdentity, form: CardForm, values: CardFormValues) => void;
  onReviewForm?: (identity: CardFormIdentity, form: CardForm, values: CardFormValues) => void;
  onCarryForm?: (identity: CardFormIdentity, form: CardForm) => void;
  onDiscardForm?: (identity: CardFormIdentity) => void;
  onSend?: (text: string) => void;
  onRefresh?: RefreshCard;
}) {
  const eventGroups = new Map<string, Raw[]>();
  for (const event of cards.filter((card) => str(card.kind) === 'calendar-event')) {
    const start = str(event.start);
    const label = calendarDayLabel(event.allDay === true ? start.slice(0, 10) : start, timeZone);
    eventGroups.set(label, [...(eventGroups.get(label) ?? []), event]);
  }
  const displayCards: Raw[] = [
    ...[...eventGroups.entries()].map(([title, events]) => ({
      kind: 'calendar-day',
      id: `calendar-day-${title}`,
      title,
      events,
    })),
    ...cards.filter((card) => str(card.kind) !== 'calendar-event'),
  ].filter((card) =>
    str(card.kind) === 'generated-card'
      ? generatedCardCapability(card, {
          onSendAvailable: Boolean(onSend),
          onCardFormReviewAvailable: Boolean(
            conversationId && formSessionScope && onReviewForm && onChangeForm,
          ),
        }).shell
      : specializedCardHasVisibleContent(card),
  );
  const preview = displayCards.slice(0, PREVIEW_LIMIT);
  const overflow = displayCards.slice(PREVIEW_LIMIT);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {preview.map((card, index) => (
        <ResponseCardView
          key={str(card.id) || index}
          data={card}
          timeZone={timeZone}
          conversationId={conversationId}
          formSessionScope={formSessionScope}
          formDraft={formDraft}
          formError={formError}
          onChangeForm={onChangeForm}
          onReviewForm={onReviewForm}
          onCarryForm={onCarryForm}
          onDiscardForm={onDiscardForm}
          onSend={onSend}
          onRefresh={onRefresh}
        />
      ))}
      {overflow.length > 0 ? (
        <details className="paper rounded-[var(--radius-card)] border border-edge/70 bg-raised px-4 py-3">
          <summary className="disclosure flex cursor-pointer select-none items-center gap-2 text-xs font-medium text-muted">
            {overflow.length} more {overflow.length === 1 ? 'result' : 'results'}
          </summary>
          <div className="mt-3 flex min-w-0 flex-col gap-2">
            {overflow.map((card, index) => (
              <ResponseCardView
                key={str(card.id) || index}
                data={card}
                timeZone={timeZone}
                conversationId={conversationId}
                formSessionScope={formSessionScope}
                formDraft={formDraft}
                formError={formError}
                onChangeForm={onChangeForm}
                onReviewForm={onReviewForm}
                onCarryForm={onCarryForm}
                onDiscardForm={onDiscardForm}
                onSend={onSend}
                onRefresh={onRefresh}
              />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
