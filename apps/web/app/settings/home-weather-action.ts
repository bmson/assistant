'use server';

import { saveHomeWeather } from '@assistant/application/home-weather';
import { revalidatePath } from 'next/cache';
import { requireOwner } from '@/auth';
import { homeWeatherSettingsPorts } from '@/lib/server';

export interface HomeWeatherFormState {
  message: string;
  error: boolean;
}
export async function updateHomeWeather(
  _previous: HomeWeatherFormState,
  form: FormData,
): Promise<HomeWeatherFormState> {
  await requireOwner();
  const city = form.get('city');
  if (typeof city !== 'string') return { message: 'Enter a home city.', error: true };
  try {
    const { repository, agentId } = await homeWeatherSettingsPorts();
    const result = await saveHomeWeather(repository, agentId, {
      city,
      enabled: form.get('enabled') === 'on',
    });
    if (!result.saved) return { message: result.error, error: true };
    revalidatePath('/settings');
    return {
      message: result.choice ? 'Home weather settings saved.' : 'Home removed.',
      error: false,
    };
  } catch {
    return { message: 'Home could not be saved. Try again.', error: true };
  }
}
