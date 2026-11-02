// 결제 v0 유스케이스(docs/features/payment.md §13 동작 2 ③): 결제 행 → 결제사 승인(응답을 기다림) → 결제 행 결과.
// 결과 모름(응답 유실·시간 초과·5xx)·처리 중·입금 대기·금액 다름은 실패로 적고 결제사에 다시 묻지 않는다(K7의 v0 한계).
import { confirmIdemKey, type ConfirmResult, type PaymentGatewayPort } from '@peaket/payment-svc/payment';
import { ApprovalNotRecordedError, type PaymentRequest, type PaymentResult, type Payments } from '../domain/payment.js';
import type { PaymentStore } from '../domain/ports.js';

/** 실패 기록 칸의 길이 상한 */
const FAILURE_MAX = 100;
/** 승인 기록을 적는 시도 수(잠깐의 연결 대기·잠금 경합을 넘기려고) [가정] */
const RECORD_ATTEMPTS = 3;
/** 결제사 쪽 실패라 카드 거절로 보지 않는 범주(한도 초과, 결제사 인증·내부 오류) */
const PG_SIDE: ReadonlySet<string> = new Set(['THROTTLED', 'PG_ERROR']);

function failureOf(c: ConfirmResult, amountMismatch: boolean): string {
  // 결과/실패 범주:결제사 코드(예 DECLINED/CARD_DECLINED:REJECT_CARD_COMPANY, DECLINED/THROTTLED:TOO_MANY_REQUESTS, UNKNOWN)
  const s = amountMismatch
    ? `AMOUNT_MISMATCH:${c.outcome}`
    : `${c.outcome}${c.failureCategory ? `/${c.failureCategory}` : ''}${c.pgCode ? `:${c.pgCode}` : ''}`;
  return s.slice(0, FAILURE_MAX);
}

/** 결제 함수 묶음(포트만 쓴다). 조립은 모듈의 payments.ts가 한다 */
export function paymentsWith(store: PaymentStore, gateway: PaymentGatewayPort): Payments {
  return {
    async confirm(r: PaymentRequest): Promise<PaymentResult> {
      const ins = await store.insertConfirming({ orderId: r.orderId, eventId: r.eventId, pg: gateway.pg, paymentKey: r.paymentKey, amount: r.amount, nowMs: r.nowMs });
      if (ins.kind === 'already-exists') return { kind: 'already-exists' };
      let c: ConfirmResult;
      try {
        c = await gateway.confirm({ orderId: r.orderId, paymentRef: r.paymentKey, amount: r.amount, idemKey: confirmIdemKey(r.orderId) });
      } catch {
        // 어댑터는 끊김·시간 초과를 결과 모름으로 돌려준다. 던지는 것은 호출 전 검사뿐이라 보냈는지 모른다
        c = { outcome: 'UNKNOWN', paymentRef: r.paymentKey };
      }
      const approved = c.outcome === 'APPROVED' || c.outcome === 'ALREADY_APPROVED';
      if (approved && c.amount === r.amount) {
        const at = c.approvedAt === undefined ? Number.NaN : Date.parse(c.approvedAt);
        const approvedAtMs = Number.isFinite(at) ? at : r.nowMs;
        // 결과를 아는 승인이다. 기록이 끊기면 몇 번 다시 적고, 끝내 못 적으면 부르는 쪽이 좌석을 되돌리지 않게 알린다
        for (let attempt = 1; ; attempt += 1) {
          try {
            await store.markApproved(ins.paymentId, approvedAtMs);
            break;
          } catch (err) {
            if (attempt >= RECORD_ATTEMPTS) throw new ApprovalNotRecordedError(ins.paymentId, { cause: err });
          }
        }
        return { kind: 'approved', paymentId: ins.paymentId, approvedAtMs };
      }
      const failure = failureOf(c, approved);
      await store.markFailed(ins.paymentId, failure);
      // 거절은 카드·사용자·검증·기한 때문일 때만이다. 결제사 한도 초과·결제사 인증 오류는 결제사 쪽 실패(502)다
      const declined = c.outcome === 'DECLINED' && !(c.failureCategory !== undefined && PG_SIDE.has(c.failureCategory));
      return declined ? { kind: 'declined', paymentId: ins.paymentId, failure } : { kind: 'failed', paymentId: ins.paymentId, failure };
    },
  };
}
