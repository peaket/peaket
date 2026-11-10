// 유스케이스 층: 회차 하나의 판정을 Problem으로 바꾼다(공연 등록과 회차 더하기가 같은 순서로 쓴다, ADR-0198 결정 2).
import type { RegistrationTx } from '../domain/ports.js';
import { SALE_END_BEFORE_START_MS } from '../domain/production.js';
import { type EventDraft, OPEN_GAP_MS, SUGGEST_HORIZON_MS, checkEventDraft, checkOpenSlot } from '../domain/registration.js';
import { eventScheduleInvalid, openMaintenanceWindow, openTooClose, queueOrderInvalid } from './problems.js';

/** 일정·정렬 설정(422). DB를 읽지 않는다 */
export function assertDraft(e: EventDraft, eventIndex: number, now: Date): void {
  const p = checkEventDraft(e, now);
  if (p === 'event-schedule-invalid') throw eventScheduleInvalid(eventIndex);
  if (p === 'queue-order-invalid') throw queueOrderInvalid(eventIndex);
}

/**
 * 정비 창·오픈 간격(409). 공개 중인 다른 공연(한 번 판매 승인되고 판매 중지가 아님)의 회차와만 견준다(ADR-0198 결정 2):
 * 공개 공연의 오픈 시각은 이미 공개된 값이라 드러날 것이 없고, 승인 전 공연이 인기 시각을 차지해 남을 막지 못한다.
 * 승인 전 공연끼리의 간격은 판매 승인(LCH-080)이 다시 본다. 등록 잠금 안에서 부른다
 */
export async function assertOpenSlot(tx: Pick<RegistrationTx, 'otherOpenTimes'>, e: EventDraft, eventIndex: number, productionId: string): Promise<void> {
  const t = e.openAt.getTime();
  const others = await tx.otherOpenTimes(new Date(t - OPEN_GAP_MS), new Date(t + SUGGEST_HORIZON_MS + OPEN_GAP_MS), productionId);
  const r = checkOpenSlot(e.openAt, others, new Date(e.startsAt.getTime() - SALE_END_BEFORE_START_MS - 1));
  if (r.ok) return;
  throw r.reason === 'open-maintenance-window' ? openMaintenanceWindow(eventIndex, r.suggestedOpenAt) : openTooClose(eventIndex, r.suggestedOpenAt);
}
