/**
 * Conservative fit checks for native date/select controls. Browser-native
 * picker chrome is not part of the CSS text box, so each control reserves a
 * small trailing lane before deciding whether to show a full-value caption.
 */
export type NativeValueControl = HTMLInputElement | HTMLSelectElement;

const px = (value: string): number => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function formatDateInputValue(value: string, locale?: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || year > 9999) return null;
  const date = new Date(0);
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'UTC',
  }).format(date);
}

/**
 * Estimates only the visible text lane. Chromium does not expose the
 * date-input shadow text's intrinsic clipping through scrollWidth, so date
 * controls reserve 48 CSS px for the segmented picker affordance; selects
 * reserve 32 CSS px for their native disclosure indicator. If canvas metrics
 * are unavailable, fail conservatively and show the full value.
 */
export function nativeValueNeedsCaption(
  control: NativeValueControl,
  value: string,
  kind: 'date' | 'choice',
): boolean {
  if (!value) return false;
  if (control.clientWidth <= 0) return true;
  const style = window.getComputedStyle(control);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return true;
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  if (style.fontSize !== '10px' && context.font === '10px sans-serif') return true;
  const letterSpacing = style.letterSpacing === 'normal' ? 0 : px(style.letterSpacing);
  const textWidth =
    context.measureText(value).width + Math.max(0, value.length - 1) * letterSpacing;
  const availableWidth =
    control.clientWidth -
    px(style.paddingLeft) -
    px(style.paddingRight) -
    (kind === 'date' ? 48 : 32);
  return textWidth > availableWidth;
}
