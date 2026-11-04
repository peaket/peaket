// 도메인 층: 공연 등록·회차 더하기의 회차 판정과 변경분(ADR-0198 결정 2·3, POL-003·030·041, BUILD_ORDER HOT-171).
// 프레임워크·플랫폼 형을 가져오지 않는다(순수 함수).
import { SALE_END_BEFORE_START_MS } from './production.js';

export type SeatAssignment = 'PICK' | 'AUTO';

/** 회차 하나의 입력(openapi PartnerEventCreate). 기본값을 채운 뒤의 모양이다 */
export interface EventDraft {
  openAt: Date;
  lobbyMinutes: number;
  entryOpensAt?: Date;
  startsAt: Date;
  endsAt: Date;
  reentryAllowed: boolean;
  lobbyShuffle: boolean;
  openBatch: boolean;
  seatAssignment: SeatAssignment;
  perPersonLimit: number;
}

/** 계약의 기본값(로비 10분 [가정], 재입장 불허, 정렬 두 값 켬, 직접 선택, 1인 4매 [가정]) */
export function withEventDefaults(e: Pick<EventDraft, 'openAt' | 'startsAt' | 'endsAt'> & Partial<EventDraft>): EventDraft {
  return { lobbyMinutes: 10, reentryAllowed: false, lobbyShuffle: true, openBatch: true, seatAssignment: 'PICK', perPersonLimit: 4, ...e };
}

export type EventDraftProblem = 'event-schedule-invalid' | 'queue-order-invalid';

/**
 * 회차 하나의 일정·정렬 설정 판정. 지금 < 오픈 < 판매 종료(공연 시작 − 24시간) < 공연 시작 < 공연 종료, 입장 시작 ≤ 공연 시작이 아니면 일정 오류,
 * 로비 셔플과 오픈 직후 묶음이 둘 다 꺼졌으면 정렬 오류(ADR-0118). 맞으면 null
 */
export function checkEventDraft(e: EventDraft, now: Date): EventDraftProblem | null {
  const open = e.openAt.getTime();
  const start = e.startsAt.getTime();
  const saleEnd = start - SALE_END_BEFORE_START_MS;
  const scheduleOk = now.getTime() < open && open < saleEnd && saleEnd < start && start < e.endsAt.getTime() && (e.entryOpensAt === undefined || e.entryOpensAt.getTime() <= start);
  if (!scheduleOk) return 'event-schedule-invalid';
  if (!e.lobbyShuffle && !e.openBatch) return 'queue-order-invalid';
  return null;
}

const MIN = 60_000;
const KST_OFFSET_MS = 9 * 60 * MIN;
/** 오픈을 막는 정비 창: 수요일 03:00~06:30 KST, 양 끝은 된다(docs/devops.md '오픈 시각 제한') */
const WINDOW_START_MIN = 3 * 60;
const WINDOW_END_MIN = 6 * 60 + 30;
/** 다른 공연과의 최소 오픈 간격(POL-030 일반 공연) */
export const OPEN_GAP_MS = 5 * MIN;
/** 가능 시각을 찾는 범위 [가정]. 저장소는 오픈 − 5분 ~ 오픈 + 이 값 사이의 다른 공연 오픈만 읽는다 */
export const SUGGEST_HORIZON_MS = 24 * 60 * MIN;

/** 그 시각이 정비 창 안인가(양 끝 제외) */
export function inMaintenanceWindow(t: Date): boolean {
  const kst = new Date(t.getTime() + KST_OFFSET_MS);
  if (kst.getUTCDay() !== 3) return false;
  const ms = ((kst.getUTCHours() * 60 + kst.getUTCMinutes()) * 60 + kst.getUTCSeconds()) * 1000 + kst.getUTCMilliseconds();
  return ms > WINDOW_START_MIN * MIN && ms < WINDOW_END_MIN * MIN;
}

/** t가 든 정비 창이 끝나는 시각(그날 06:30 KST) */
function windowEnd(t: Date): Date {
  const kst = new Date(t.getTime() + KST_OFFSET_MS);
  const endKst = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate(), 0, WINDOW_END_MIN);
  return new Date(endKst - KST_OFFSET_MS);
}

export type OpenSlotResult = { ok: true } | { ok: false; reason: 'open-maintenance-window' | 'open-too-close'; suggestedOpenAt?: Date };

/**
 * 오픈 시각 판정(정비 창 → 오픈 간격 차례). others는 비교할 다른 공연 회차의 오픈 시각이다(같은 공연은 넣지 않는다).
 * 막히면 요청한 시각 뒤로 가장 이른, 두 규칙에 모두 걸리지 않는 시각을 제안한다. 찾는 범위는 SUGGEST_HORIZON_MS와 latest(판매 종료 직전) 가운데
 * 이른 쪽까지이고, 그 안에 없으면 제안을 싣지 않는다(제안대로 다시 보냈는데 일정 오류가 나지 않게)
 */
export function checkOpenSlot(t: Date, others: readonly Date[], latest?: Date): OpenSlotResult {
  const tooClose = (c: number) => others.filter((o) => Math.abs(o.getTime() - c) < OPEN_GAP_MS);
  let reason: 'open-maintenance-window' | 'open-too-close' | undefined;
  if (inMaintenanceWindow(t)) reason = 'open-maintenance-window';
  else if (tooClose(t.getTime()).length > 0) reason = 'open-too-close';
  if (!reason) return { ok: true };
  // 막는 구간은 모두 열린 구간이라, 가장 이른 가능 시각은 막는 구간의 오른쪽 끝 가운데 하나다. 걸릴 때마다 그 끝으로 옮긴다(늘 앞으로만 간다)
  let c = t.getTime();
  const limit = Math.min(t.getTime() + SUGGEST_HORIZON_MS, latest ? latest.getTime() : Number.POSITIVE_INFINITY);
  while (c <= limit) {
    if (inMaintenanceWindow(new Date(c))) {
      c = windowEnd(new Date(c)).getTime();
      continue;
    }
    const near = tooClose(c);
    if (near.length === 0) return { ok: false, reason, suggestedOpenAt: new Date(c) };
    c = Math.max(...near.map((o) => o.getTime())) + OPEN_GAP_MS;
  }
  return { ok: false, reason };
}

/** 판매 승인 뒤 더한 회차(변경분, docs/data.md production.pending_revision.addedEvents). 판매 승인이 같은 ID로 event 행에 옮긴다 */
export interface PendingEvent extends EventDraft {
  eventId: string;
  addedAt: Date;
}

/** 찜 상한(계정마다, openapi wish-limit) [가정] */
export const WISH_LIMIT = 1000;
