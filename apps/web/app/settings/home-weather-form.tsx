'use client';

import { useActionState } from 'react';
import { Card, SectionHeading } from '@/lib/ui';
import { SubmitButton } from '@/lib/ui-client';
import { updateHomeWeather } from './home-weather-action';

export function HomeWeatherForm({
  choice,
}: {
  choice: { city: string; enabled: boolean } | null | undefined;
}) {
  const [state, action, pending] = useActionState(updateHomeWeather, { message: '', error: false });
  return (
    <section className="grid gap-4 border-t border-edge/70 pt-8">
      <SectionHeading title="Home weather" />
      {choice === undefined ? (
        <p role="alert" className="text-sm text-muted">
          Home settings couldn’t be loaded. Reopen Settings to try again.
        </p>
      ) : (
        <Card>
          <form action={action} className="grid gap-4">
            <p className="text-sm text-muted" id="home-weather-privacy">
              Save a town or city to use for weather when your phone hasn’t shared a recent
              location. The weather provider receives the city for lookup and its approximate
              coordinates for forecasts.
            </p>
            <fieldset
              key={`${choice?.city}:${choice?.enabled}`}
              disabled={pending}
              className="grid gap-4"
            >
              <label className="grid gap-1 text-sm font-medium">
                Home city
                <input
                  name="city"
                  autoComplete="off"
                  defaultValue={choice?.city ?? ''}
                  aria-describedby="home-weather-privacy home-weather-remove"
                  className="rounded-lg border border-edge bg-surface px-3 py-2"
                  maxLength={160}
                />
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input name="enabled" type="checkbox" defaultChecked={choice?.enabled ?? false} />
                Use Home for weather when phone location is unavailable
              </label>
              <p className="text-sm text-muted" id="home-weather-remove">
                To remove Home, clear the city, turn off the checkbox and save.
              </p>
              <div>
                <SubmitButton>Save Home settings</SubmitButton>
              </div>
            </fieldset>
            <p role={state.error ? 'alert' : 'status'} className="text-sm">
              {state.message}
            </p>
          </form>
        </Card>
      )}
    </section>
  );
}
