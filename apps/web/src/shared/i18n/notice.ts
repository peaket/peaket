// 구매 조건 알림(docs/frontend.md §5.12, POL-001, NFR-024). en·ja·zh 화면에만 한 줄로 보인다.
import { loadMessages, translate, type Locale } from './catalog.ts';

export async function domesticPhoneNotice(locale: Locale | undefined): Promise<string | undefined> {
  if (!locale || locale === 'ko') return undefined;
  return translate(await loadMessages(locale), 'identity.domesticPhoneRequired');
}
