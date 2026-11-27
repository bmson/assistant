import { randomUUID } from 'node:crypto';
import { geocodePlace } from '@assistant/core/memory/ambient';
import {
  type HomeWeatherRepository,
  type HomeWeatherSettings,
  homeWeatherSettings,
} from '@assistant/persistence';

export type HomeWeatherUpdate =
  | { saved: true; choice: HomeWeatherSettings | null }
  | { saved: false; error: string };

export async function saveHomeWeather(
  repository: HomeWeatherRepository,
  agentId: string,
  input: { city: string; enabled: boolean },
  resolve: typeof geocodePlace = geocodePlace,
): Promise<HomeWeatherUpdate> {
  const city = input.city.trim();
  let choice: HomeWeatherSettings | null = null;
  if (city) {
    const current = await repository.getHomeWeather(agentId);
    if (current?.city === city) {
      if (current.enabled === input.enabled) return { saved: true, choice: current };
      choice = { ...current, revision: randomUUID(), enabled: input.enabled };
    } else {
      if (city.length > 100 || !/^[\p{L}\p{M} ,.'’-]+$/u.test(city))
        return { saved: false, error: 'Enter a town or city and its region.' };
      const resolved = await resolve(city);
      const parsed = homeWeatherSettings.safeParse({
        city: resolved?.label,
        lat: resolved?.lat,
        lng: resolved?.lng,
        enabled: input.enabled,
        revision: randomUUID(),
      });
      if (!parsed.success)
        return {
          saved: false,
          error: 'We couldn’t find that city. Include its region and try again.',
        };
      choice = parsed.data;
    }
  } else if (input.enabled) {
    return { saved: false, error: 'Enter a home city to enable weather.' };
  }

  if (!(await repository.setHomeWeather(agentId, choice)))
    return { saved: false, error: 'Home could not be saved for this account.' };
  const saved = await repository.getHomeWeather(agentId);
  if (saved?.revision !== choice?.revision)
    return {
      saved: false,
      error: 'Home changed before the save could be confirmed. Reopen Settings.',
    };
  return { saved: true, choice: saved };
}
