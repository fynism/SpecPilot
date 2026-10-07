import { catalogs } from './catalogs.js';

export type Locale = keyof typeof catalogs;
export type TextKey = keyof (typeof catalogs)['zh-CN'];
export function translate(
  locale: Locale,
  key: TextKey,
  values: Record<string, string | number> = {},
): string {
  return catalogs[locale][key].replace(/\{([^}]+)\}/g, (_match, name: string) =>
    String(values[name] ?? `{${name}}`),
  );
}
export function resolveLocale(value: string): Locale | null {
  const normalized = value.trim().toLowerCase().replaceAll('_', '-');
  if (['zh', 'zh-cn'].includes(normalized)) return 'zh-CN';
  if (['en', 'en-us'].includes(normalized)) return 'en-US';
  return null;
}
