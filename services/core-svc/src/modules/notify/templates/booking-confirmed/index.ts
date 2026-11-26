// F-06-8 예매 확정 이메일 템플릿(ADR-0388, notify §4.9.2).
// 템플릿은 코드에 고정하고 값은 자리표시자로만 넣는다(ASVS 1.3.7). 외부 이미지·추적 픽셀·JavaScript·폼이 없다.
import type { SellerNoticeInfo } from '../../domain/fan-notify-ports.js';

export const BOOKING_CONFIRMED_TEMPLATE_VERSION = 'v1';
export type BookingLocale = 'ko' | 'en' | 'ja' | 'zh';
export const BOOKING_LOCALES: readonly BookingLocale[] = ['ko', 'en', 'ja', 'zh'];

const INTERMEDIARY =
  '판매자: {seller}. PEAKET은 통신판매중개자로서 이 공연의 당사자가 아닙니다. 공연의 개최·변경·취소에 따른 책임은 판매자에게 있고, 예매 취소와 환불은 PEAKET이 처리합니다.';
const MINOR =
  '만 19세 미만 미성년자가 법정대리인(부모 등)의 동의 없이 결제하면, 미성년자 본인이나 법정대리인이 이 계약을 취소할 수 있습니다.';
const CANCEL_REFUND = '공연일 10일 이내 취소 시 기준에 따른 공제 후 환불됩니다.';

const TEXT: Record<BookingLocale, { title: string; intro: string; ticket: string; cancel: string; help: string; subject: string }> = {
  ko: {
    title: '예매가 확정되었습니다',
    intro: '예매가 확정되었습니다.',
    ticket: '티켓은 마이 티켓에서 확인할 수 있습니다.',
    cancel: '취소·환불 안내',
    help: '궁금한 점은 피켓 고객센터로 문의해 주세요.',
    subject: '{production} 예매가 확정되었습니다',
  },
  en: {
    title: 'Your booking is confirmed',
    intro: 'Your booking is confirmed.',
    ticket: 'You can view your ticket in My Tickets.',
    cancel: 'Cancellation and refund',
    help: 'If you have any questions, contact PEAKET support.',
    subject: 'Your booking for {production} is confirmed',
  },
  ja: {
    title: '予約が確定しました',
    intro: '予約が確定しました。',
    ticket: 'チケットはマイチケットで確認できます。',
    cancel: 'キャンセル・返金のご案内',
    help: 'ご不明な点はPEAKETサポートまでお問い合わせください。',
    subject: '{production} の予約が確定しました',
  },
  zh: {
    title: '预订已确认',
    intro: '您的预订已确认。',
    ticket: '您可以在“我的门票”中查看门票。',
    cancel: '取消与退款说明',
    help: '如有疑问，请联系 PEAKET 客服。',
    subject: '{production} 的预订已确认',
  },
};

const escapeHtml = (v: string): string =>
  v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const oneLine = (v: string): string => v.replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').trim();

export function resolveBookingLocale(locale: string | undefined): { locale: BookingLocale; missing: boolean } {
  const base = (locale ?? '').toLowerCase().split(/[-_]/)[0];
  if ((BOOKING_LOCALES as readonly string[]).includes(base)) return { locale: base as BookingLocale, missing: false };
  return { locale: 'ko', missing: true };
}

export interface BookingTemplateInput {
  vars: Readonly<Record<string, string | number>>;
  seller: SellerNoticeInfo | null;
  customerCenterUrl: string;
  publicOrigin: string;
}

export interface RenderedBookingEmail {
  version: string;
  subject: string;
  text: string;
  html: string;
}

export function renderBookingConfirmed(locale: BookingLocale, input: BookingTemplateInput): RenderedBookingEmail {
  const production = oneLine(String(input.vars.productionName ?? ''));
  const venue = oneLine(String(input.vars.venueName ?? ''));
  const starts = oneLine(String(input.vars.eventStartsAt ?? ''));
  const seats = oneLine(String(input.vars.seatSummary ?? ''));
  const amount = Number(input.vars.amount ?? 0);
  const last4 = oneLine(String(input.vars.bookingNoLast4 ?? ''));
  const orderId = oneLine(String(input.vars.orderId ?? ''));
  const seller = input.seller;
  const sellerName = seller ? oneLine(seller.legalName) : '';
  const orderUrl = `${input.publicOrigin.replace(/\/+$/, '')}/my/orders/${encodeURIComponent(orderId)}`;
  const helpUrl = input.customerCenterUrl;
  const t = TEXT[locale];
  const subject = oneLine(t.subject.replace('{production}', production));
  const sellerLine = seller
    ? `상호: ${sellerName} · 대표자: ${seller.representative} · 주소: ${seller.address} · 전화: ${seller.phone} · 전자우편: ${seller.email} · 사업자등록번호: ${seller.businessRegNo} · 통신판매업 신고번호: ${seller.mailOrderReportNo}`
    : '';
  const intermediary = INTERMEDIARY.replace('{seller}', sellerName);
  const lines = [
    `${t.intro} ${production} ${starts} (${venue})`,
    `${seats} · 결제 금액 ₩${amount.toLocaleString('ko-KR')} · 예매번호 끝 4자리 ${last4}`,
    t.ticket,
    orderUrl,
    sellerLine,
    intermediary,
    MINOR,
    CANCEL_REFUND,
    t.help,
    helpUrl,
  ];
  const text = lines.filter((line) => line.length > 0).join('\n\n');
  const sellerHtml = seller
    ? `<div class="seller-info" style="font-size:14px;line-height:1.6">
        <div>상호: ${escapeHtml(seller.legalName)}</div>
        <div>대표자: ${escapeHtml(seller.representative)}</div>
        <div>주소: ${escapeHtml(seller.address)}</div>
        <div>전화: ${escapeHtml(seller.phone)}</div>
        <div>전자우편: ${escapeHtml(seller.email)}</div>
        <div>사업자등록번호: ${escapeHtml(seller.businessRegNo)}</div>
        <div>통신판매업 신고번호: ${escapeHtml(seller.mailOrderReportNo)}</div>
      </div>`
    : '';
  const html = `<!doctype html>
<html lang="${locale}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title>
<style>
body{margin:0;padding:0;background:#f6f6f6;color:#1a1a1a;font-family:Arial,'Noto Sans KR',sans-serif}
.wrap{width:100%;max-width:600px;margin:0 auto;background:#ffffff}
.inner{padding:24px}
h1{font-size:22px;line-height:1.4;margin:0 0 16px}
h2{font-size:16px;margin:24px 0 8px}
p{margin:0 0 12px;line-height:1.6}
.seller-info{font-size:14px;line-height:1.6;background:#fafafa;padding:12px;border:1px solid #e5e5e5}
.legal-notice{font-size:14px;line-height:1.6;margin:16px 0;padding:12px;border-left:4px solid #555}
a{color:#0b57d0}
@media (prefers-color-scheme: dark){body{background:#111;color:#eee}.wrap{background:#1c1c1c}.seller-info{background:#222;border-color:#444}.legal-notice{border-color:#aaa}a{color:#8ab4f8}}
</style></head>
<body><div class="wrap"><div class="inner">
<h1>${escapeHtml(subject)}</h1>
<p>${escapeHtml(`${t.intro} ${production} ${starts} (${venue})`)}</p>
<p>${escapeHtml(`${seats} · 결제 금액 ₩${amount.toLocaleString('ko-KR')} · 예매번호 끝 4자리 ${last4}`)}</p>
<p>${escapeHtml(t.ticket)}</p>
<p><a href="${escapeHtml(orderUrl)}">예매 확인서 보기</a></p>
<h2>판매자 정보</h2>
${sellerHtml}
<div class="legal-notice" data-legal="intermediary" style="font-size:14px">${escapeHtml(intermediary)}</div>
<div class="legal-notice" data-legal="minor" style="font-size:14px">${escapeHtml(MINOR)}</div>
<div class="legal-notice" data-legal="cancel-refund" style="font-size:14px">${escapeHtml(`${CANCEL_REFUND} ${t.cancel}`)}</div>
<p>${escapeHtml(t.help)}</p>
<p><a href="${escapeHtml(helpUrl)}">고객센터</a></p>
</div></div></body></html>`;
  return { version: BOOKING_CONFIRMED_TEMPLATE_VERSION, subject, text, html };
}
