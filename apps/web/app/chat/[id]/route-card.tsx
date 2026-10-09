'use client';

import Image from 'next/image';
import { useState } from 'react';

type Raw = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const rec = (value: unknown): Raw | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : undefined;

/** US zones read distances in miles; everywhere else in kilometers. */
const MILES_ZONE =
  /^(?:America\/(?:New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit|Boise|Juneau|Indiana|Kentucky|Menominee|Nome|Sitka|Yakutat|Adak|Metlakatla|North_Dakota)|Pacific\/Honolulu|US\/)/;

export function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

export function formatDistance(meters: number, timeZone: string): string {
  if (MILES_ZONE.test(timeZone)) {
    const miles = meters / 1609.344;
    return miles < 0.2
      ? `${Math.round(meters * 3.28084)} ft`
      : `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`;
  }
  return meters < 1000
    ? `${Math.round(meters)} m`
    : `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`;
}

function clock(value: string, timeZone: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? ''
    : new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone }).format(
        date,
      );
}

const MODE_WORD: Record<string, string> = { driving: 'drive', walking: 'walk', cycling: 'ride' };

function snapshotSrc(data: Raw, scheme: 'light' | 'dark'): string | undefined {
  const from = rec(data.origin);
  const to = rec(data.destination);
  const line = str(data.polyline);
  if (!from || !to || !line) return undefined;
  const params = new URLSearchParams({
    from: `${num(from.lat)},${num(from.lng)}`,
    to: `${num(to.lat)},${num(to.lng)}`,
    line,
    scheme,
  });
  return `/api/maps/snapshot?${params}`;
}

/**
 * A route: the map, how long, how far, and when to leave or arrive, with the
 * turn-by-turn tucked away and one tap to Apple Maps. Mirrors RouteCardView
 * on iOS, which draws a live MapKit map instead of the image.
 */
export function RouteCard({ data, timeZone }: { data: Raw; timeZone: string }) {
  const destination = rec(data.destination) ?? {};
  const origin = rec(data.origin) ?? {};
  const seconds = num(data.durationSeconds);
  const meters = num(data.distanceMeters);
  const mode = str(data.mode) || 'driving';
  const leave = clock(str(data.departAt), timeZone);
  const arrive = clock(str(data.arriveAt), timeZone);
  const steps = Array.isArray(data.steps) ? data.steps.map(rec).filter((s): s is Raw => !!s) : [];
  const light = snapshotSrc(data, 'light');
  const dark = snapshotSrc(data, 'dark');
  const mapsUrl = /^https:\/\/maps\.apple\.com\//.test(str(data.mapsUrl)) ? str(data.mapsUrl) : '';
  // No map at all beats a broken frame: without a maps key (or when Apple is
  // down) the card is still the time, the distance, and the link.
  const [mapFailed, setMapFailed] = useState(false);
  const hideMap = () => setMapFailed(true);
  return (
    <div className="flex flex-col gap-3">
      {light && dark && !mapFailed ? (
        <a
          href={mapsUrl || undefined}
          target="_blank"
          rel="noopener noreferrer"
          className="-mx-4 -mt-3 block overflow-hidden border-b border-edge/60 sm:-mx-5"
          aria-label={`Open the route to ${str(destination.label)} in Apple Maps`}
        >
          <Image
            src={light}
            alt=""
            width={600}
            height={300}
            unoptimized
            loading="lazy"
            onError={hideMap}
            className="block h-auto w-full dark:hidden"
          />
          <Image
            src={dark}
            alt=""
            width={600}
            height={300}
            unoptimized
            loading="lazy"
            onError={hideMap}
            className="hidden h-auto w-full dark:block"
          />
        </a>
      ) : null}
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-2xl font-semibold text-strong tabular-nums">
          {seconds !== undefined && seconds >= 0 ? formatDuration(seconds) : 'Duration unavailable'}
        </p>
        <p className="text-sm text-muted tabular-nums">
          {meters !== undefined && meters >= 0
            ? formatDistance(meters, timeZone)
            : 'Distance unavailable'}
          {str(data.routeName) ? ` · via ${str(data.routeName)}` : ''}
        </p>
      </div>
      <div className="text-sm">
        <p className="font-medium text-strong">{str(destination.label)}</p>
        {str(destination.address) ? (
          <p className="text-xs text-muted">{str(destination.address)}</p>
        ) : null}
        <p className="mt-1 text-xs text-muted">
          {MODE_WORD[mode] ? `By ${MODE_WORD[mode]} from ` : 'From '}
          {origin.current === true ? 'where you are' : str(origin.label)}
          {leave && arrive ? ` · leave ${leave}, arrive ${arrive}` : ''}
          {data.hasTolls === true ? ' · tolls' : ''}
        </p>
      </div>
      {steps.length ? (
        <details className="border-t border-edge/60 pt-2 text-sm">
          <summary className="cursor-pointer text-xs font-medium text-muted">
            {steps.length} step{steps.length === 1 ? '' : 's'}
          </summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-strong">
            {steps.map((step) => {
              const distance = num(step.distanceMeters);
              return (
                <li key={`${str(step.instruction)}-${distance}`}>
                  {str(step.instruction)}
                  {distance !== undefined && distance >= 0 ? (
                    <span className="text-xs text-muted">
                      {' '}
                      · {formatDistance(distance, timeZone)}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </details>
      ) : null}
      {mapsUrl ? (
        <a
          href={mapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="self-start rounded-full bg-accent px-3.5 py-1.5 text-xs font-semibold text-on-accent hover:bg-accent-hover"
        >
          Open in Apple Maps
        </a>
      ) : null}
    </div>
  );
}
