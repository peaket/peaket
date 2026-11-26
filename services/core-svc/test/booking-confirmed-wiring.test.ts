// F-06-8 IR068-01·03·05·06·07·08·09: 조립·held_event 위치·판매자 7항목·catalog 실패·KST·표 HTML·제목 접두어.
import { describe, expect, test } from 'vitest';
import { CatalogBookingNoticeView, renderBookingConfirmed, SesMailTransport } from '../src/modules/notify/index.js';
import { FAN_NOTIFY_MAIL, fanNotifyProviders } from '../src/modules/notify/notify.module.js';
import { CATALOG, SELLER, eventOf, setupBooking } from './booking-confirmed-support.js';
import { OPTOUT_KEY } from './fan-notify-support.js';

const input = (locale: 'ko' | 'en' | 'ja' | 'zh' = 'ko') => ({
  vars: {
    productionName: '겨울 콘서트',
    eventStartsAt: '2026-12-24T10:30:00.000Z',
    venueName: '피켓홀',
    seatSummary: 'R석 2매',
    amount: 220_000,
    bookingNoLast4: '0001',
    orderId: '0190f3a1-7c2e-7f00-8000-0000000000f1',
  },
  seller: SELLER,
  customerCenterUrl: 'https://peaket.example/support',
  publicOrigin: 'https://peaket.example',
  locale,
});

describe('F-06-8 구현 리뷰 IR068', () => {
  test('IR068-01 운영 메일 환경 값이 있으면 SES 어댑터를 조립한다', () => {
    const { providers } = fanNotifyProviders({
      storage: 'memory',
      env: {
        PEAKET_ENV: 'prod',
        PEAKET_NOTIFY_MAIL_FROM: '피켓 <no-reply@notify.peaket.example>',
        PEAKET_NOTIFY_MAIL_REPLY_TO: 'help@peaket.example',
      },
      wiring: { optOutKey: OPTOUT_KEY },
    });
    const mail = providers.find((p) => (p as { provide?: unknown }).provide === FAN_NOTIFY_MAIL) as { useValue?: unknown } | undefined;
    expect(mail?.useValue).toBeInstanceOf(SesMailTransport);
  });

  test('IR068-03 held_event에 실제 Kafka partition·offset을 넘긴다', async () => {
    const t = setupBooking({ subscriptions: 0 });
    t.noticeReader.get = async () => {
      throw new Error('purchase-svc timeout');
    };
    const r = await t.intake.bookingConfirmed(eventOf(t, { partition: 3, kafkaOffset: 42 }));
    expect(r).toMatchObject({ held: true });
    expect(t.held.rows[0]).toMatchObject({ partition: 3, kafkaOffset: 42 });
  });

  test('IR068-05 판매자는 신고번호나 면제 근거가 있어야 하고 면제 근거를 버리지 않는다', async () => {
    const row = {
      production: { title: '겨울 콘서트' },
      place: { name: '피켓홀' },
      event: { startsAt: new Date('2026-12-24T10:30:00.000Z') },
      priceTiers: [{ tierId: 'R', name: 'R석' }],
      seller: {
        legalName: '(주)겨울공연',
        representative: '김대표',
        address: '서울특별시 중구 세종대로 1',
        phone: '02-1234-5678',
        email: 'seller@example.test',
        businessRegNo: '123-45-67890',
        mailOrderReportNo: null,
        exemptionBasis: '통신판매업 신고 면제 대상',
      },
    };
    const view = new CatalogBookingNoticeView({ findEventSummary: async () => row } as never);
    const out = await view.getBookingNotice('0190f3a1-7c2e-7c00-8000-0000000000c1', ['R']);
    expect((out?.seller as { exemptionBasis?: string } | null | undefined)?.exemptionBasis).toBe('통신판매업 신고 면제 대상');

    const missing = new CatalogBookingNoticeView({
      findEventSummary: async () => ({ ...row, seller: { ...row.seller, mailOrderReportNo: null, exemptionBasis: null } }),
    } as never);
    expect((await missing.getBookingNotice('0190f3a1-7c2e-7c00-8000-0000000000c1', ['R']))?.seller).toBeNull();
  });

  test('IR068-06 catalog 없음·장소 없음·noticeReader 없음은 작업을 만들지 않고 보류한다', async () => {
    const noCatalog = setupBooking({ catalog: null, subscriptions: 0 });
    expect(await noCatalog.intake.bookingConfirmed(eventOf(noCatalog))).toMatchObject({ held: true });
    expect(noCatalog.store.jobs.size).toBe(0);

    const noVenue = setupBooking({ catalog: { ...CATALOG, venueName: '' }, subscriptions: 0 });
    expect(await noVenue.intake.bookingConfirmed(eventOf(noVenue))).toMatchObject({ held: true });
    expect(noVenue.store.jobs.size).toBe(0);

    const noReader = setupBooking({ withoutNoticeReader: true, subscriptions: 0 });
    expect(await noReader.intake.bookingConfirmed(eventOf(noReader))).toMatchObject({ held: true });
    expect(noReader.store.jobs.size).toBe(0);
  });

  test('IR068-07·08·09 이메일은 KST·600px 표·인라인 CSS·[피켓] 제목을 쓴다', () => {
    const r = renderBookingConfirmed('ko', input('ko'));
    expect(r.subject.startsWith('[피켓] ')).toBe(true);
    expect((r as { body?: string }).body).toContain('19:30');
    expect((r as { body?: string }).body).not.toContain('10:30');
    expect(r.html).toContain('19:30');
    expect(r.html).not.toContain('10:30');
    expect(r.html).toMatch(/<table[^>]*(?:width="600"|width:600px)/i);
    expect(r.html).not.toContain('<style');
    expect(r.html).toContain('style="');
    for (const locale of ['ko', 'en', 'ja', 'zh'] as const) {
      expect(renderBookingConfirmed(locale, input(locale)).subject.startsWith('[피켓] ')).toBe(true);
    }
  });
});
