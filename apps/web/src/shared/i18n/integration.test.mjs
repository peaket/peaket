// LCH-190 구매 조건 알림이 로그인·공연 상세의 구매 버튼 가까이에 붙어 있는지 소스로 확인한다.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../../../../../', import.meta.url);
const at = (p) => new URL(p, root);
const text = (p) => readFileSync(at(p), 'utf8');

test('LCH-190 로그인·공연 상세가 로케일별 구매 조건 알림을 넘긴다', () => {
  const login = text('apps/web/src/_pages/login/ui/LoginPage.tsx');
  assert.match(login, /domesticPhoneNotice\(locale\)/);
  assert.match(login, /<DomesticPhoneNotice/);
  assert.match(login, /lang=\{locale\}/);
  const detail = text('apps/web/src/_pages/event-detail/ui/EventDetailPage.tsx');
  assert.match(detail, /domesticPhoneNotice\(locale\)/);
  assert.match(detail, /domesticPhoneNotice: notice/);
  const booking = text('apps/web/src/_pages/event-detail/ui/Booking.tsx');
  assert.match(booking, /<DomesticPhoneNotice/);
  assert.match(booking, /data\.domesticPhoneNotice/);
  assert.match(booking, /lang=\{data\.locale\}/);
  assert.equal((booking.match(/<DomesticPhoneNotice/g) ?? []).length, 2, '구매 버튼 가까이 두 곳(모바일·데스크톱)');
  const notice = text('apps/web/src/shared/i18n/DomesticPhoneNotice.tsx');
  assert.match(notice, /role="note" lang=\{lang\}/);
});

test('LCH-190 로케일 접두 로그인·공연 상세 경로가 있다', () => {
  assert.ok(existsSync(at('apps/web/app/(request)/[locale]/login/page.tsx')));
  assert.ok(existsSync(at('apps/web/app/(cached)/[locale]/events/[id]/page.tsx')));
  const login = text('apps/web/app/(request)/[locale]/login/page.tsx');
  const detail = text('apps/web/app/(cached)/[locale]/events/[id]/page.tsx');
  assert.match(login, /isLocale\(locale\)/);
  assert.match(login, /locale === 'ko'\) notFound\(\)/);
  assert.match(detail, /isLocale\(locale\)/);
  assert.match(detail, /locale === 'ko'\) notFound\(\)/);
  assert.match(detail, /canonical:.*\$\{locale\}\/events\/\$\{id\}/);
});
