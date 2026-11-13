// 소비자 웹 문구 카탈로그의 첫 조각(docs/frontend.md §5.12, NFR-024, ADR-0079 결정 29).
// 이번 단계는 구매 조건 알림 한 키와 번역 검토 표시만 둔다. 전체 화면 문구의 i18next 연결은 다국어 단계에서 이 모양을 그대로 쓴다.
import type ko from './messages/ko.json';

export const LOCALES = ['ko', 'en', 'ja', 'zh'] as const;
export type Locale = (typeof LOCALES)[number];
export type Messages = typeof ko;
export type MessageKey = keyof Messages;
export type Review = 'machine' | 'native';

const loaders: Record<Locale, () => Promise<{ default: Messages }>> = {
  ko: () => import('./messages/ko.json', { with: { type: 'json' } }),
  en: () => import('./messages/en.json', { with: { type: 'json' } }),
  ja: () => import('./messages/ja.json', { with: { type: 'json' } }),
  zh: () => import('./messages/zh.json', { with: { type: 'json' } }),
};

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/** 번역 파일을 로케일 하나만 늦게 읽는다(초기 번들에 네 언어를 넣지 않는다) */
export async function loadMessages(locale: Locale): Promise<Messages> {
  return (await loaders[locale]()).default;
}

/** `{이름}` 자리를 값으로 바꾼다. 사용자 값을 형식 문자열로 쓰지 않는다(ASVS 1.3.10) */
export function translate(messages: Messages, key: MessageKey, vars: Record<string, string | number> = {}): string {
  const entry = messages[key];
  if (!entry || typeof entry.text !== 'string' || entry.text.length === 0) throw new Error(`i18n missing key: ${key}`);
  return entry.text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/** 로케일 접두 주소. 한국어는 접두가 없다(ADR-0060 결정 3) */
export function localePath(locale: Locale, path: string): string {
  return locale === 'ko' ? path : `/${locale}${path.startsWith('/') ? path : `/${path}`}`;
}

/** 페이지의 hreflang 대안 주소. 한국어 접두 없음, 나머지는 /en·/ja·/zh */
export function languageAlternates(path: string): Record<Locale, string> {
  return { ko: path, en: `/en${path}`, ja: `/ja${path}`, zh: `/zh${path}` };
}
