// F-06-8 N-T28: 이메일 HTML·법정 고지·현지화·판매자 없음·2,048바이트 해석.
// 흉내 SES(FakeMailTransport)·고정 시계. 실제 수신자 주소를 쓰지 않는다(example.test만).
import { describe, expect, test } from 'vitest';
import { messageOf, type NotificationJob } from '../src/modules/notify/index.js';
import { assertVars } from '../src/modules/notify/domain/fan-notify.js';
import { bookingJob, CATALOG, SELLER, setupBooking, NOW } from './booking-confirmed-support.js';

type MailWithHtml = { to: string; subject: string; body: string; html?: string; headers: Record<string, string> };
type DeliveryWithVersion = { templateVersion?: string; status: string; channel: string };

const SELLER_VALUES = ['(주)겨울공연', '김대표', '서울특별시 중구 세종대로 1', '02-1234-5678', 'seller@example.test', '123-45-67890', '2026-서울중구-0001'];
/** §4.8의 고정 고지 문장. 번역 검토 전에는 en/ja/zh도 이 한국어 문장을 쓴다(B-04) */
const INTERMEDIARY = '판매자: (주)겨울공연. PEAKET은 통신판매중개자로서 이 공연의 당사자가 아닙니다. 공연의 개최·변경·취소에 따른 책임은 판매자에게 있고, 예매 취소와 환불은 PEAKET이 처리합니다.';
const MINOR = '만 19세 미만 미성년자가 법정대리인(부모 등)의 동의 없이 결제하면, 미성년자 본인이나 법정대리인이 이 계약을 취소할 수 있습니다.';
const CANCEL_REFUND = '공연일 10일 이내 취소 시 기준에 따른 공제 후 환불됩니다.';

function assertEmail(m: MailWithHtml, orderId: string) {
  expect(m.html).toBeTruthy();
  const html = m.html!;
  for (const value of SELLER_VALUES) {
    expect(html).toContain(value);
    expect(m.body).toContain(value);
  }
  // 법정 고지 블록이 접히지 않고 네 언어 모두에 있으며, 번역 검토 전이라 §4.8의 한국어 문장 그대로다
  for (const block of ['intermediary', 'minor', 'cancel-refund']) {
    expect(html).toContain(`data-legal="${block}"`);
    expect(html).toContain('class="legal-notice"');
  }
  for (const sentence of [INTERMEDIARY, MINOR, CANCEL_REFUND]) {
    expect(html).toContain(sentence);
    expect(m.body).toContain(sentence);
  }
  // 외부 이미지·추적 픽셀·JavaScript·폼이 없다
  expect(html).not.toMatch(/<img\b/i);
  expect(html).not.toMatch(/<script\b/i);
  expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  expect(html).not.toMatch(/http-equiv/i);
  expect(html).not.toMatch(/background-image\s*:\s*url\(/i);
  // text와 html이 같은 링크를 담는다
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((x) => x[1]!);
  expect(hrefs).toContain(`https://peaket.example/my/orders/${orderId}`);
  for (const href of hrefs) expect(m.body).toContain(href);
  // 판매자·고지 글씨가 판매자 표시보다 작지 않다(14px 이상)
  expect(html).toMatch(/(?:\.seller-info[^{]*\{[^}]*font-size:\s*(?:1[4-9]|[2-9]\d)px|font-size:\s*(?:1[4-9]|[2-9]\d)px[^>]*class="seller-info")/);
  expect(html).toMatch(/(?:\.legal-notice[^{]*\{[^}]*font-size:\s*(?:1[4-9]|[2-9]\d)px|font-size:\s*(?:1[4-9]|[2-9]\d)px[^>]*class="legal-notice")/);
  expect(m.body.length).toBeGreaterThan(0);
}

describe('F-06-8 예매 확정 이메일', () => {
  test('N-T28 ko/en/ja/zh 이메일 HTML·text에 판매자 7항목·법정 고지가 있고 외부 이미지·추적 픽셀·JavaScript가 없다', async () => {
    for (const locale of ['ko', 'en', 'ja', 'zh'] as const) {
      const t = setupBooking({ locale, subscriptions: 0 });
      bookingJob(t, { channel: 'EMAIL', templateVersion: 'v1' });
      const run = await t.worker.processDue(new Date(NOW));
      expect(run.sent).toBe(1);
      const m = t.mail.sent[0] as MailWithHtml;
      expect(m.html).toMatch(new RegExp(`<html[^>]*lang="${locale}"`, 'i'));
      assertEmail(m, t.orderId);
      const delivery = t.store.deliveries[0] as DeliveryWithVersion;
      expect(delivery).toMatchObject({ status: 'SENT', channel: 'EMAIL', templateVersion: 'v1' });
    }
  });

  test('N-T28 번역 누락은 ko로 가고 template_missing을 올리며, 판매자 정보가 없으면 이메일만 재시도한다', async () => {
    const fallback = setupBooking({ locale: 'fr', subscriptions: 0 });
    bookingJob(fallback, { channel: 'EMAIL', templateVersion: 'v1' });
    expect((await fallback.worker.processDue(new Date(NOW))).sent).toBe(1);
    const m = fallback.mail.sent[0] as MailWithHtml;
    expect(m.html).toMatch(/<html[^>]*lang="ko"/i);
    expect(m.body).toContain('통신판매중개자');
    expect(fallback.counts.templateMissing).toEqual(['fr']);

    const noSeller = setupBooking({ subscriptions: 1, catalog: null });
    const email = bookingJob(noSeller, { channel: 'EMAIL', templateVersion: 'v1' });
    const push = bookingJob(noSeller, {
      channel: 'WEB_PUSH',
      subscriptionKey: [...noSeller.store.push.values()][0]!.endpointHash,
      templateVersion: 'v1',
    });
    const run = await noSeller.worker.processDue(new Date(NOW));
    expect(run).toMatchObject({ attempted: 2, sent: 1, retrying: 1 });
    expect(noSeller.mail.sent).toHaveLength(0);
    expect(noSeller.push.sent).toHaveLength(1);
    const retry = noSeller.store.jobs.get(email.dedupKey) as NotificationJob;
    expect(retry).toMatchObject({ status: 'RETRYING', attempts: 1 });
    expect(retry.nextAttemptAt.getTime()).toBe(NOW + 60_000);
    expect(noSeller.store.jobs.has(push.dedupKey)).toBe(false);
  });

  test('N-T28 이메일 HTML은 2,048바이트를 넘어도 자르지 않고, 웹 푸시 평문만 2,048바이트 아래로 둔다', async () => {
    const t = setupBooking({ subscriptions: 0 });
    // vars 1KB 상한 안에서 긴 공연명을 만든다(240자 ≈ 720바이트 + 나머지 키)
    const longName = '겨울'.repeat(120);
    const vars = {
      productionName: longName,
      eventStartsAt: '2026-12-24T19:30:00+09:00',
      venueName: '피켓홀',
      seatSummary: 'R석 2매, S석 1매',
      amount: 308_000,
      bookingNoLast4: '0001',
      orderId: t.orderId,
    };
    expect(Buffer.byteLength(JSON.stringify(vars), 'utf8')).toBeLessThanOrEqual(1_024);
    bookingJob(t, { channel: 'EMAIL', vars, templateVersion: 'v1' });
    expect((await t.worker.processDue(new Date(NOW))).sent).toBe(1);
    const m = t.mail.sent[0] as MailWithHtml;
    expect(Buffer.byteLength(m.html ?? '', 'utf8')).toBeGreaterThan(2_048);
    expect(m.html).toContain(longName);
    expect(m.body).toContain(longName);
    for (const block of ['intermediary', 'minor', 'cancel-refund']) expect(m.html).toContain(`data-legal="${block}"`);

    // 같은 긴 값의 웹 푸시 평문도 2,048바이트 아래다
    const push = messageOf('BOOKING_CONFIRMED' as never, vars);
    expect(Buffer.byteLength(JSON.stringify({ v: 1, kind: 'BOOKING_CONFIRMED', ...push, tag: 'a'.repeat(32) }), 'utf8')).toBeLessThan(2_048);

    // 악성 공연명·판매자 값은 HTML에서 이스케이프된다(assertVars는 PII·제어 문자만 막는다, §12)
    const evil = '<script>alert(1)</script><img src=x onerror=alert(1)>';
    const evilVars = {
      productionName: evil,
      eventStartsAt: '2026-12-24T19:30:00+09:00',
      venueName: evil,
      seatSummary: 'R석 2매',
      amount: 220_000,
      bookingNoLast4: '0001',
      orderId: '0190f3a1-7c2e-7f00-8000-0000000000f1',
    };
    expect(() => assertVars('BOOKING_CONFIRMED' as never, evilVars)).not.toThrow();
    const evilT = setupBooking({ subscriptions: 0 });
    evilT.catalog.getBookingNotice = async () => ({
      ...CATALOG,
      productionName: evil,
      venueName: evil,
      seller: { ...SELLER, legalName: evil, representative: evil, address: evil },
    });
    bookingJob(evilT, { channel: 'EMAIL', vars: evilVars, templateVersion: 'v1' });
    expect((await evilT.worker.processDue(new Date(NOW))).sent).toBe(1);
    const evilMail = evilT.mail.sent[0] as MailWithHtml;
    expect(evilMail.html).not.toMatch(/<script\b/i);
    expect(evilMail.html).not.toMatch(/<img\b/i);
    expect(evilMail.html).toContain('&lt;script&gt;');
    expect(evilMail.html).toContain('&lt;img');
    // text 판은 태그가 글자로 보이는 것이 정상이다
    expect(evilMail.body).toContain(evil);
  });
});
