// 유스케이스: 웹훅 공유 토큰 확인(docs/observability.md §5 '진단 증거' 받는 길, ASVS v5.0.0-16.3.3, 시험 D-T51 ④).
// Authorization: Bearer <PEAKET_EVIDENCE_WEBHOOK_TOKEN>만 받는다. 없으면 missing, 틀리면 mismatch로 거절을 남긴다(토큰 값은 남기지 않는다).
// 비교는 상수 시간(@peaket/platform constantTimeEqual)이다. 공용 InternalTokenGuard는 거절을 남기지 않아 수집기는 이 확인을 따로 둔다.
import { constantTimeEqual } from '@peaket/platform';

export type WebhookRejectReason = 'missing' | 'mismatch';
export const WEBHOOK_REJECT_REASONS: readonly WebhookRejectReason[] = ['missing', 'mismatch'];

export class VerifyWebhook {
  readonly #token: string;
  readonly #onRejected: (reason: WebhookRejectReason) => void;

  constructor(o: { token: string; onRejected: (reason: WebhookRejectReason) => void }) {
    if (!o.token) throw new Error('웹훅 토큰이 비었다');
    this.#token = o.token;
    this.#onRejected = o.onRejected;
  }

  /** Authorization 머리 값을 보고 받으면 true. 거절이면 남기고 false */
  check(authorization: string | undefined): boolean {
    const m = typeof authorization === 'string' ? /^Bearer[ ]+(\S+)[ ]*$/i.exec(authorization) : null;
    if (!m) {
      this.#onRejected('missing');
      return false;
    }
    if (!constantTimeEqual(m[1]!, this.#token)) {
      this.#onRejected('mismatch');
      return false;
    }
    return true;
  }
}
