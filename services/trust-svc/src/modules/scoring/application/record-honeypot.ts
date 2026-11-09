// 허니팟 적중 기록(docs/features/bot-defense.md §7·§4.8, ADR-0249 결정 3).
// 응답은 조건과 상관없이 204이고(받는 층), 여기서는 조건을 만족한 요청만 센다. 로그인한 적중만 사람에 잇는다.
import { type Clock, uuidv7 } from '@peaket/platform';
import { countsAsHoneypotHit, type HoneypotHeaders } from '../domain/honeypot.js';
import type { FeatureStore, HoneypotRecorder, TrustSignals } from '../domain/ports.js';

/** Redis 키에 들어가는 pid의 모양 */
const KEY_PART = /^[A-Za-z0-9_-]{1,64}$/;
/** 저장소의 회차 ID 형식(소문자 UUID). trust-svc는 회차가 실제로 있는지 알 길이 없어 이 꼴과 pid당 회차 수 상한으로만 막는다(ADR-0249 결정 3) */
const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface HoneypotHit extends HoneypotHeaders {
  /** 게이트웨이가 검증해 넘긴 사람 식별값 */
  pid: string | undefined;
  /** pid 키 전환 기간의 옛 pid(x-user-pid-prev). 있으면 판정의 읽기와 같은 기준으로 이 값에 쓴다 */
  pidPrev?: string | undefined;
  /** 링크가 있던 회차(쿼리 e) */
  eventId: string | undefined;
}

export interface RecordHoneypotDeps {
  features: Pick<FeatureStore, 'recordHoneypot'>;
  recorder: HoneypotRecorder;
  signals: Pick<TrustSignals, 'honeypotHit' | 'afterFailed'>;
  clock: Clock;
  /** 응답 뒤로 미룰 일을 맡긴다 */
  after: (work: () => Promise<void>) => void;
}

export class RecordHoneypot {
  constructor(private readonly d: RecordHoneypotDeps) {}

  run(hit: HoneypotHit): void {
    if (!countsAsHoneypotHit(hit)) return;
    // queue-svc는 전환 기간에 옛 pid로 판정받는다(§3 'pid 키 전환 기간'). 표시도 같은 키에 써야 다음 판정이 읽는다
    const pid = [hit.pidPrev, hit.pid].find((p): p is string => p !== undefined && KEY_PART.test(p));
    const eventId = hit.eventId !== undefined && EVENT_ID.test(hit.eventId) ? hit.eventId : '';
    this.d.signals.honeypotHit(pid !== undefined);
    if (pid === undefined) return;
    const now = this.d.clock.now();
    this.d.after(async () => {
      try {
        // (pid, 회차)마다 24시간에 판정 기록 한 번이고 pid당 회차 수에 상한이 있다. 계약의 eventId는 필수라 회차를 모르면 표시만 쓴다
        const first = await this.d.features.recordHoneypot({ pid, eventId, now });
        if (first && eventId !== '') this.d.recorder.honeypot({ eventKey: uuidv7(this.d.clock), eventId, occurredAtMs: now });
      } catch {
        this.d.signals.afterFailed('honeypot');
      }
    });
  }
}
