'use client';

import { SunMoon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { type Appearance, applyAppearance, readAppearance } from '@/lib/appearance';
import { iconButtonClass, selectClass } from '@/lib/ui';
import { ActionMenu } from '@/lib/ui-client';

/** Keeps the system option live as the OS changes, including across browser tabs. */
export function AppearanceControl() {
  const [appearance, setAppearance] = useState<Appearance>('system');
  const selected = useRef<Appearance>('system');
  useEffect(() => {
    const saved = readAppearance();
    selected.current = saved;
    setAppearance(saved);
    applyAppearance(saved);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystemChange = () => {
      if (selected.current === 'system') applyAppearance('system');
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== 'theme' && event.key !== null) return;
      const next = readAppearance();
      selected.current = next;
      setAppearance(next);
      applyAppearance(next);
    };
    media.addEventListener('change', onSystemChange);
    window.addEventListener('storage', onStorage);
    return () => {
      media.removeEventListener('change', onSystemChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return (
    <label className="grid min-w-0 gap-2 text-sm font-medium text-strong">
      Appearance
      <select
        aria-label="Appearance"
        className={`${selectClass} w-full`}
        value={appearance}
        onChange={(event) => {
          const next = event.target.value as Appearance;
          selected.current = next;
          setAppearance(next);
          try {
            if (next === 'system') localStorage.removeItem('theme');
            else localStorage.setItem('theme', next);
          } catch {
            // The chosen appearance still applies when storage is unavailable.
          }
          applyAppearance(next);
        }}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}

/** Theme is a preference, so it should not consume a row of page navigation. */
export function AppearanceMenu() {
  return (
    <ActionMenu
      trigger={
        <>
          <SunMoon className="size-4" aria-hidden="true" />
          <span className="sr-only">Appearance</span>
        </>
      }
      triggerTitle="Appearance"
      triggerClassName={iconButtonClass}
      panelClassName="w-64"
    >
      <div className="grid gap-2 p-3">
        <AppearanceControl />
        <p className="text-xs leading-5 text-muted">System follows your device’s appearance.</p>
      </div>
    </ActionMenu>
  );
}
