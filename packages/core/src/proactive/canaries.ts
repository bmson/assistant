import { type Config, isModuleEnabled } from '@assistant/config';
import { googleCalendarOAuthConfig } from '@assistant/config/google-calendar';
import {
  GOOGLE_CALENDAR_READ_SCOPE,
  PROACTIVE_SMS_DAILY_LIMIT,
  type ProactiveCanaryRepository,
  PULSE_INTERVAL_MS,
  phoneCalendarSourceCoverage,
  readProactiveSmsQuota,
} from '@assistant/persistence';
import {
  AMBIENT_TTL_MINUTES,
  type AmbientWeatherSources,
  ambientWeatherOnLocalDate,
  getEnabledHomeWeather,
  matchesAmbientSource,
} from '../memory/ambient.js';
import { latestLocation } from '../memory/location.js';

const DAY_MS = 24 * 60 * 60_000;
export type CanaryState =
  | 'fresh'
  | 'awaiting_first_run'
  | 'connected'
  | 'within_limit'
  | 'at_limit'
  | 'disabled'
  | 'not_configured'
  | 'configured_unverified'
  | 'unverified'
  | 'expired'
  | 'missing'
  | 'overdue'
  | 'incomplete'
  | 'unavailable';
interface Canary {
  state: CanaryState;
  observedAt?: string;
}

function freshness(value: string, now: Date, ttlMs: number): Canary {
  const at = Date.parse(value);
  const age = now.getTime() - at;
  if (!Number.isFinite(age) || age < 0) return { state: 'unavailable' };
  return { state: age < ttlMs ? 'fresh' : 'expired', observedAt: new Date(at).toISOString() };
}

async function checked<T extends Canary>(
  fn: () => Promise<T>,
): Promise<T | { state: 'unavailable' }> {
  try {
    return await fn();
  } catch {
    return { state: 'unavailable' };
  }
}

export async function assessProactiveCanaries(
  repo: ProactiveCanaryRepository,
  owner: string,
  config: Config,
  now = new Date(),
  configuration: 'agent' | 'observer' = 'agent',
) {
  const [pulse, googleCalendar, phoneCalendar, weather, urgentSms] = await Promise.all([
    checked(async (): Promise<Canary> => {
      const { schedule, completedAt } = await repo.pulse(owner);
      if (!schedule) return { state: 'missing' };
      if (!schedule.enabled) return { state: 'disabled' };
      if ((schedule.taskTemplate as { job?: string } | null)?.job !== 'pulse.check')
        return { state: 'unavailable' };
      if (completedAt && completedAt >= schedule.createdAt) {
        const result = freshness(completedAt.toISOString(), now, PULSE_INTERVAL_MS);
        return result.state === 'expired' ? { ...result, state: 'overdue' } : result;
      }
      const activation = freshness(schedule.createdAt.toISOString(), now, PULSE_INTERVAL_MS).state;
      return {
        state:
          activation === 'fresh'
            ? 'awaiting_first_run'
            : activation === 'expired'
              ? 'overdue'
              : 'unavailable',
      };
    }),
    checked(async (): Promise<Canary> => {
      if (!isModuleEnabled(config, 'google') && !isModuleEnabled(config, 'calendar'))
        return { state: 'disabled' };
      const botConfigured = Boolean(
        config.GOOGLE_OAUTH_CLIENT_ID &&
          config.GOOGLE_OAUTH_CLIENT_SECRET &&
          config.BOT_GOOGLE_REFRESH_TOKEN,
      );
      const connection = (await repo.google.get(owner))?.connection;
      if (!connection)
        return {
          state: botConfigured
            ? 'configured_unverified'
            : configuration === 'agent'
              ? 'not_configured'
              : 'unverified',
        };
      if (configuration === 'agent' && !googleCalendarOAuthConfig(config))
        return { state: 'unavailable' };
      if (connection.status === 'reconnect_required') return { state: 'expired' };
      if (
        connection.status !== 'connected' ||
        !connection.scopes.includes(GOOGLE_CALENDAR_READ_SCOPE)
      )
        return { state: 'unavailable' };
      return { state: 'connected' };
    }),
    checked(async (): Promise<Canary> => {
      if (!repo.phone.readSnapshot) return { state: 'unavailable' };
      const { state, snapshot } = await repo.phone.readSnapshot(owner, now);
      if (!state) return { state: 'not_configured' };
      if (!state.enabled) return { state: 'disabled' };
      if (!state.calendars.length) return { state: 'not_configured' };
      if (!state.capturedAt) {
        const sinceConsent = freshness(state.updatedAt, now, DAY_MS).state;
        return { state: sinceConsent === 'fresh' ? 'awaiting_first_run' : sinceConsent };
      }
      const result = freshness(state.capturedAt, now, DAY_MS);
      if (result.state !== 'fresh') return result;
      if (!snapshot || snapshot.capturedAt !== state.capturedAt) return { state: 'unavailable' };
      // The canonical consent/cache read already matched the selected roster.
      const { sourceComplete } = phoneCalendarSourceCoverage(snapshot);
      return snapshot.complete === true &&
        snapshot.sourceAvailability &&
        sourceComplete &&
        !snapshot.truncated
        ? result
        : { ...result, state: 'incomplete' };
    }),
    checked(async (): Promise<Canary> => {
      const [snapshot, ping] = await Promise.all([
        repo.context.getAmbientSnapshot(owner),
        latestLocation(repo.context, owner, config.LOCATION_RETENTION_DAYS, undefined, now),
      ]);
      const home = ping ? null : await getEnabledHomeWeather(repo.context, owner);
      const sources = snapshot?.sources as AmbientWeatherSources | undefined;
      if (!ping && !home && (!snapshot || sources?.home)) return { state: 'not_configured' };
      if (!snapshot) return { state: 'unavailable' };
      if (!matchesAmbientSource(sources, ping, home)) return { state: 'expired' };
      if (
        !sources?.weather?.fetchedAt ||
        (snapshot.flags as { has_weather?: boolean } | null)?.has_weather !== true
      )
        return { state: 'unavailable' };
      const status = freshness(sources.weather.fetchedAt, now, AMBIENT_TTL_MINUTES * 60_000);
      return status.state === 'fresh' && !ambientWeatherOnLocalDate(sources, now)
        ? { ...status, state: 'expired' }
        : status;
    }),
    checked(async (): Promise<Canary & { attempts?: number; limit?: number }> => {
      if (!isModuleEnabled(config, 'sms')) return { state: 'disabled' };
      const configured = Boolean(
        config.TWILIO_ACCOUNT_SID &&
          config.TWILIO_AUTH_TOKEN &&
          config.TWILIO_FROM_NUMBER &&
          config.OWNER_PHONE,
      );
      if (!configured && configuration === 'agent') return { state: 'not_configured' };
      const { cursor, timeZone } = await repo.sms(owner);
      // The web service does not mount agent provider credentials. Its absence
      // of credentials and a quota row cannot prove whether texting is configured.
      if (!configured && cursor === null) return { state: 'unverified' };
      const { day, previous } = readProactiveSmsQuota(cursor, timeZone, now);
      if (previous && previous.day > day) return { state: 'unavailable' };
      const attempts = previous?.day === day ? previous.attemptKeys.length : 0;
      return {
        state: attempts >= PROACTIVE_SMS_DAILY_LIMIT ? 'at_limit' : 'within_limit',
        attempts,
        limit: PROACTIVE_SMS_DAILY_LIMIT,
      };
    }),
  ]);
  return { pulse, googleCalendar, phoneCalendar, weather, urgentSms };
}

export type ProactiveCanaries = Awaited<ReturnType<typeof assessProactiveCanaries>>;

export const GOOGLE_CALENDAR_RECONNECT_NOTICE =
  'Google Calendar access expired. Reconnect in Google Calendar settings.';

export function proactiveCanaryProblems(canaries: ProactiveCanaries) {
  const names = {
    pulse: 'Pulse',
    googleCalendar: 'Google Calendar',
    phoneCalendar: 'Phone calendar',
    weather: 'Cached weather',
    urgentSms: 'Urgent text quota',
  };
  return (Object.keys(names) as Array<keyof ProactiveCanaries>).flatMap((key) => {
    const state = canaries[key].state;
    if (key === 'pulse' && state === 'missing')
      return [{ key, detail: 'Pulse schedule is missing.' }];
    if (key === 'googleCalendar' && state === 'expired')
      return [{ key, detail: GOOGLE_CALENDAR_RECONNECT_NOTICE }];
    return ['expired', 'overdue', 'unavailable', 'incomplete'].includes(state)
      ? [{ key, detail: `${names[key]}: ${state}.` }]
      : [];
  });
}
