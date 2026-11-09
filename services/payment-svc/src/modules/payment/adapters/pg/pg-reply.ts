// 결제사 호출과 답 읽기의 공통 부품(docs/features/payment.md §2.1). 토스 모양 어댑터와 포트원 어댑터가 함께 쓴다(BUILD_ORDER HOT-140).
// 이 파일은 v0 이미지(build:lib)에도 들어간다. 서버 전용 부품(undici, pg-http.ts)을 가져오지 않는다.
import { createHash } from 'node:crypto';
import type { ExternalHttpClient, ExternalRequest } from '@peaket/platform';
import type { PgUnreadableRow } from '../../domain/payment-gateway.js';

/** 답의 상태와 JSON 본문(JSON이 아니거나 객체가 아니면 undefined). NO_ANSWER는 끊김·시간 초과·남은 시간 없음이다 */
export type PgReply = { status: number; json: Record<string, unknown> | undefined } | 'NO_ANSWER';

export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** 못 읽는 줄에서 믿고 저장할 수 있는 참조 값의 모양: 공백·제어 문자가 없는 ASCII 1~200자(웹훅의 참조 모양과 같다) */
const SAFE_REF = /^[\x21-\x7e]{1,200}$/;

/**
 * 거래 조회의 못 읽는 줄을 기록용 값으로 바꾼다(BUILD_ORDER HOT-153 코드 리뷰 M13). 모양이 맞는 참조만 그대로 싣고, 결제 참조가 없으면 줄 전체의 SHA-256 앞 32자로 대신한다(줄 내용은 저장하지 않는다. 같은 줄은 다시 받아도 같은 값이라 기록이 한 번이다).
 * @param raw 결제사가 준 줄(모양을 믿지 않는다)
 * @param paymentRefOf 줄에서 결제 참조를 읽는다
 * @param orderRefOf 줄에서 주문 참조를 읽는다
 */
export function unreadableRowOf(raw: unknown, paymentRefOf: (row: Record<string, unknown>) => unknown, orderRefOf: (row: Record<string, unknown>, paymentRef: string | undefined) => unknown): PgUnreadableRow {
  const row = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const safe = (v: unknown): string | undefined => {
    const s = str(v);
    return s !== undefined && SAFE_REF.test(s) ? s : undefined;
  };
  const paymentRef = safe(paymentRefOf(row));
  return { paymentRef: paymentRef ?? `unreadable-${createHash('sha256').update(JSON.stringify(raw) ?? 'undefined').digest('hex').slice(0, 32)}`, orderRef: safe(orderRefOf(row, paymentRef)) ?? '' };
}

/** 결제사 한 번 부르기. 던지지 않는다: 보냈는지 처리됐는지 모르는 경우는 NO_ANSWER다 */
export async function pgRequest(http: ExternalHttpClient, request: ExternalRequest): Promise<PgReply> {
  try {
    const res = await http.request(request);
    const text = await res.text();
    let json: Record<string, unknown> | undefined;
    try {
      const v: unknown = JSON.parse(text);
      json = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  } catch {
    // 끊김·시간 초과·남은 시간 없음: 보냈는지 처리됐는지 모른다
    return 'NO_ANSWER';
  }
}
