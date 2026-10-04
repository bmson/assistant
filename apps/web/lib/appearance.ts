/** Static pre-paint script shared by the normal shell and root-error fallback. */
export const appearanceScript = `(()=>{let t;try{t=localStorage.getItem('theme')}catch{}const d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme:dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.dataset.jellyMode=d?'dark':'light';})()`;

export type Appearance = 'system' | 'light' | 'dark';

export function readAppearance(): Appearance {
  try {
    const saved = localStorage.getItem('theme');
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  } catch {
    return 'system';
  }
}

export function applyAppearance(appearance: Appearance) {
  const dark =
    appearance === 'dark' ||
    (appearance === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.dataset.jellyMode = dark ? 'dark' : 'light';
  window.dispatchEvent(new Event('app:theme-change'));
  window.dispatchEvent(new Event('jelly-theme-change'));
}
