// 결제사 호출과 답 읽기의 공통 부품(docs/features/payment.md §2.1). 토스 모양 어댑터와 포트원 어댑터가 함께 쓴다(BUILD_ORDER HOT-140).
// 이 파일은 v0 이미지(build:lib)에도 들어간다. 서버 전용 부품(undici, pg-http.ts)을 가져오지 않는다.
import type { ExternalHttpClient, ExternalRequest } from '@peaket/platform';

/** 답의 상태와 JSON 본문(JSON이 아니거나 객체가 아니면 undefined). NO_ANSWER는 끊김·시간 초과·남은 시간 없음이다 */
export type PgReply = { status: number; json: Record<string, unknown> | undefined } | 'NO_ANSWER';

export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

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
