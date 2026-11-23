// 웹훅 공유 토큰 확인(ASVS v5.0.0-16.3.3, V-T53 ⑥). Authorization: Bearer <PEAKET_ALERT_RELAY_TOKEN>만 받는다.
// 없으면 missing, 틀리면 mismatch로 거절을 남기고(토큰 값은 남기지 않는다) 처리기를 부르지 않는다. 비교는 상수 시간이다.
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
