// 구매 세션 사건으로 입장 자리를 고친다(asyncapi trade.purchase-sessions, docs/features/queue-admission.md §6, ADR-0005 결정 7, ADR-0183 결정 11).
// 시작이면 자리가 남아 있을 때만 점수를 최대 체류 시각으로 올리고, 종료면 뺀다. 사건이 빠지면 첫 사용 기한·최대 체류 시각이 자리를 정리한다(Q-T11).
// Kafka 구독(Avro 해독, BAS-030)과 보내는 쪽(purchase-svc)은 PRF-130이 이 처리기에 잇는다.
import { Inject, Injectable } from '@nestjs/common';
import { ADMISSION_STORE, type AdmissionStore } from '../domain/ports.js';

/** PurchaseSessionStarted에서 쓰는 칸(asyncapi) */
export interface SessionStarted {
  eventId: string;
  admissionJti: string;
  maxStayUntil: string;
}
/** PurchaseSessionEnded에서 쓰는 칸(asyncapi) */
export interface SessionEnded {
  eventId: string;
  admissionJti: string;
}

@Injectable()
export class PurchaseSessionSlots {
  constructor(@Inject(ADMISSION_STORE) private readonly store: AdmissionStore) {}

  /** 자리를 고쳤으면 true(이미 회수됐거나 더 늦은 값이 있으면 false) */
  async started(m: SessionStarted): Promise<boolean> {
    const maxStayUntilMs = Date.parse(m.maxStayUntil);
    if (!Number.isFinite(maxStayUntilMs)) throw new Error('PurchaseSessionStarted.maxStayUntil이 날짜가 아니다');
    return this.store.sessionStarted({ eventId: m.eventId, jti: m.admissionJti, maxStayUntilMs });
  }

  async ended(m: SessionEnded): Promise<boolean> {
    return this.store.sessionEnded({ eventId: m.eventId, jti: m.admissionJti });
  }
}
