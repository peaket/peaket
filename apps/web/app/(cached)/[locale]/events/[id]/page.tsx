// 로케일 접두 공연 상세(SCR-002, NFR-024): `/en/events/{id}`·`/ja/...`·`/zh/...`가 같은 ISR 상세를 로케일만 달리 그린다.
// 한국어는 접두가 없으므로 `/ko/events/{id}`는 받지 않는다(ADR-0060 결정 3).
import { notFound } from 'next/navigation';
import { EventDetailPage, generateMetadata as eventMetadata, generateStaticParams as eventStaticParams } from '@/_pages/event-detail';
import { SITE_ORIGIN } from '@/shared/config/origins';
import { isLocale } from '@/shared/i18n/catalog';

export const instant = false;

type Props = { params: Promise<{ locale: string; id: string }> };

/** 인기 회차를 로케일 셋에 맞춰 미리 그린다. 나머지 회차는 처음 요청 때 ISR 항목으로 만든다 */
export async function generateStaticParams(): Promise<{ locale: string; id: string }[]> {
  const events = await eventStaticParams();
  return ['en', 'ja', 'zh'].flatMap((locale) => events.map((event) => ({ locale, id: event.id })));
}

export async function generateMetadata({ params }: Props) {
  const { locale, id } = await params;
  if (!isLocale(locale) || locale === 'ko') return {};
  const m = await eventMetadata({ params: Promise.resolve({ id }) });
  return { ...m, alternates: { ...m.alternates, canonical: `${SITE_ORIGIN}/${locale}/events/${id}` } };
}

export default async function LocaleEventDetailPage({ params }: Props) {
  const { locale, id } = await params;
  if (!isLocale(locale) || locale === 'ko') notFound();
  return <EventDetailPage params={Promise.resolve({ id })} locale={locale} />;
}
