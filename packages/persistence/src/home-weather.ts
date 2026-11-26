import { z } from 'zod';

export const homeWeatherSettings = z.object({
  revision: z.string().uuid(),
  city: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .regex(/^[^\r\n]+$/),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  enabled: z.boolean(),
});

export type HomeWeatherSettings = z.infer<typeof homeWeatherSettings>;

export function readHomeWeatherSettings(value: unknown): HomeWeatherSettings | null {
  const result = homeWeatherSettings.safeParse(value);
  return result.success ? result.data : null;
}

export interface HomeWeatherRepository {
  getHomeWeather(agentId: string): Promise<HomeWeatherSettings | null>;
  setHomeWeather(agentId: string, value: HomeWeatherSettings | null): Promise<boolean>;
}
