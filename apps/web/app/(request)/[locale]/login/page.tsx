// 로케일 접두 로그인(SCR-004, NFR-024): `/en/login`·`/ja/login`·`/zh/login`이 같은 화면을 로케일만 달리 그린다.
// 한국어는 접두가 없으므로 `/ko/login`은 받지 않는다(ADR-0060 결정 3).
import { notFound } from 'next/navigation';
import { LoginPage, metadata } from '@/_pages/login';
import { isLocale } from '@/shared/i18n/catalog';
import type { SearchParams } from '@/shared/lib/page-props';

export { metadata };
export const instant = false;

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<SearchParams> };

export default async function LocaleLoginPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (!isLocale(locale) || locale === 'ko') notFound();
  return <LoginPage locale={locale} params={Promise.resolve({})} searchParams={searchParams} />;
}
