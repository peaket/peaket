// payment-svc 정산 다시 계산 내부 HTTP 어댑터(F-07-8 I-04, ADR-0380 결정 2, docs/api/guidelines.md §8.1 다시 계산 행).
// 보류 열기 PUT /internal/v1/settlements/event-recalculations/{requestId}(본문 eventId·kind·confirmedAt), 완료 POST …/{requestId}/completion(본문 completedAt·partial).
// 부르는 쪽은 purchase-svc이고 서비스 사이 공유 토큰(x-peaket-internal-token)을 싣는다. 한 번의 한도는 3초 [가정](서킷 읽기와 같다).
// 2xx가 아니거나 응답이 없으면 SettlementNoticeError를 던진다. 메시지에는 요청 ID만 싣는다(회차 ID·주소·원래 오류 글은 싣지 않는다).
import type { ExternalHttpClient } from '@peaket/platform';
import type { SettlementRecalculationPort } from '../domain/event-refund-ports.js';

/** 정산 알리기 한 번의 한도 3초 [가정] */
export const SETTLEMENT_NOTICE_TIMEOUT_MS = 3_000;
const OPEN_PATH = '/internal/v1/settlements/event-recalculations/{requestId}';
const COMPLETE_PATH = '/internal/v1/settlements/event-recalculations/{requestId}/completion';

/** 정산 알리기 실패. 메시지에는 요청 ID와 단계·상태 코드(있으면)만 있다 */
export class SettlementNoticeError extends Error {
  constructor(
    readonly requestId: string,
    readonly stage: 'open' | 'complete',
    readonly status?: number,
  ) {
    super(`정산 ${stage === 'open' ? '보류 열기' : '완료 알리기'}를 payment-svc가 받지 않았다(요청 ${requestId}${status === undefined ? '' : `, 상태 ${status}`})`);
    this.name = 'SettlementNoticeError';
  }
}

export class HttpSettlementRecalculation implements SettlementRecalculationPort {
  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    private readonly internalToken?: string,
  ) {}

  async open(input: { requestId: string; eventId: string; kind: 'CANCEL' | 'POSTPONE'; confirmedAt: Date }): Promise<void> {
    await this.#send('open', 'PUT', OPEN_PATH, input.requestId, { eventId: input.eventId, kind: input.kind, confirmedAt: input.confirmedAt.toISOString() });
  }

  async complete(requestId: string, input: { completedAt: Date; partial: boolean }): Promise<void> {
    await this.#send('complete', 'POST', COMPLETE_PATH, requestId, { completedAt: input.completedAt.toISOString(), partial: input.partial });
  }

  async #send(stage: 'open' | 'complete', method: 'PUT' | 'POST', path: string, requestId: string, body: Record<string, unknown>): Promise<void> {
    let res: Response;
    try {
      res = await this.client.request({
        method,
        path,
        params: { requestId },
        headers: { 'content-type': 'application/json', ...(this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {}) },
        body: JSON.stringify(body),
        timeoutCapMs: SETTLEMENT_NOTICE_TIMEOUT_MS,
      });
    } catch {
      // 원래 오류 글(주소·연결 정보)을 싣지 않는다
      throw new SettlementNoticeError(requestId, stage);
    }
    // 본문은 읽어 연결을 돌려준다(쓰지는 않는다)
    await res.arrayBuffer().catch(() => undefined);
    if (res.status < 200 || res.status > 299) throw new SettlementNoticeError(requestId, stage, res.status);
  }
}

/**
 * 주소(PEAKET_PAYMENT_HTTP_URL)가 없을 때의 '보내지 않음' 대역. local·ci·test·demo만 쓰고 경고 한 줄을 남긴 뒤 보낸 것으로 친다.
 * 그 밖의 환경은 시작하지 않는다(정산 보류가 조용히 빠지는 것을 막는다)
 */
export function unsentSettlementRecalculation(envName: string | undefined, warn: (o: object, msg: string) => void): SettlementRecalculationPort {
  const name = envName ?? 'local';
  if (name !== 'local' && name !== 'ci' && name !== 'test' && name !== 'demo') throw new Error('PEAKET_PAYMENT_HTTP_URL이 없다(회차 취소 정산 다시 계산 알리기, 운영 필수)');
  return {
    open: async (input) => warn({ event: 'event-refund-settlement-notice-skipped', requestId: input.requestId, stage: 'open' }, '정산 보류 열기를 보내지 않았다(payment-svc 주소 없음)'),
    complete: async (requestId) => warn({ event: 'event-refund-settlement-notice-skipped', requestId, stage: 'complete' }, '정산 완료 알리기를 보내지 않았다(payment-svc 주소 없음)'),
  };
}
