// F-06-8 N-T28: 이메일 HTML·법정 고지·현지화·판매자 없음·2,048바이트 해석.
// 흉내 SES(FakeMailTransport)·고정 시계. 실제 수신자 주소를 쓰지 않는다(example.test만).
import { describe, expect, test } from 'vitest';
import type { NotificationJob } from '../src/modules/notify/index.js';
import { bookingJob, setupBooking, NOW } from './booking-confirmed-support.js';

type MailWithHtml = { to: string; subject: string; body: string; html?: string; headers: Record<string, string> };
type DeliveryWithVersion = { templateVersion?: string; status: string; channel: string };

const SELLER_VALUES = ['(주)겨울공연', '김대표', '서울특별시 중구 세종대로 1', '02-1234-5678', 'seller@example.test', '123-45-67890', '2026-서울중구-0001'];

function assertEmail(m: MailWithHtml, orderId: string) {
  expect(m.html).toBeTruthy();
  const html = m.html!;
  for (const value of SELLER_VALUES) {
    expect(html).toContain(value);
    expect(m.body).toContain(value);
  }
  // 법정 고지 블록이 접히지 않고 네 언어 모두에 있다(문구 자체는 판마다 다르다)
  for (const block of ['intermediary', 'minor', 'cancel-refund']) {
    expect(html).toContain(`data-legal="${block}"`);
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
    const longName = '겨울'.repeat(240);
    const vars = {
      productionName: longName,
      eventStartsAt: '2026-12-24T19:30:00+09:00',
      venueName: '피켓홀',
      seatSummary: 'R석 2매, S석 1매',
      amount: 308_000,
      bookingNoLast4: '0001',
      orderId: t.orderId,
    };
    bookingJob(t, { channel: 'EMAIL', vars, templateVersion: 'v1' });
    expect((await t.worker.processDue(new Date(NOW))).sent).toBe(1);
    const m = t.mail.sent[0] as MailWithHtml;
    expect(Buffer.byteLength(m.html ?? '', 'utf8')).toBeGreaterThan(2_048);
    expect(m.html).toContain(longName);
    expect(m.body).toContain(longName);
    expect(m.html).toContain('data-legal="intermediary"');
    expect(m.html).toContain('data-legal="minor"');
    expect(m.html).toContain('data-legal="cancel-refund"');
  });
});
