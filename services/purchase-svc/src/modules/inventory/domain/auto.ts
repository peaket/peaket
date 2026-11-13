// 자동 좌석 배정의 순수 규칙(docs/features/seat-hold.md §3 '자동 좌석 배정 모드', POL-035, FR-050, ADR-0043, BUILD_ORDER HOT-080).
// 후보 목록 만들기·희망 조건 검사·멱등 지문만 둔다. 실제 비트 확인과 홀드는 auto-hold-lua.ts가 한 원자 연산으로 한다.
// 후보의 선호 차례는 지금 판의 구역 차례·구역 안 거리 차례(앞쪽 우선)다. 파트너가 정한 선호 순서 칸은 판 파일에 아직 없어
// 이 단계는 결정적 기본값을 쓴다(무대 중앙 기준은 시안 확정 뒤 그 칸을 더한다, POL-035).
import { createHash } from 'node:crypto';
import { type HeldHold, MAX_SEATS, type SeatRef } from './hold.js';

/** 희망 조건(openapi HoldRequest.auto). 브라우저가 대기 중 저장했다가 차례가 오면 보낸다 */
export interface AutoCondition {
  firstTierId: string;
  secondTierId?: string;
  count: number;
  /** 휠체어석이 필요한가. 참이면 휠체어석만, 거짓이면 휠체어석을 뺀다 */
  wheelchair: boolean;
  /** 연석이 없을 때 같은 등급의 분리 좌석을 허용하는가 */
  allowSplit: boolean;
}

/** 배정 결과 유형(openapi Hold.assignResult) */
export type AutoAssignResult = 'FIRST' | 'FIRST_SPLIT' | 'SECOND' | 'SECOND_SPLIT';

/**
 * 자동 배정 후보 묶음 하나.
 * - split=false: seats가 곧 하나의 연석 블록이다(길이 = 희망 매수). 그 좌석들이 모두 비어야 잡는다.
 * - split=true: seats는 같은 등급의 낱개 후보들이다. Lua가 앞에서부터 빈 좌석을 희망 매수만큼 고른다.
 */
export interface AutoCandidateGroup {
  assignResult: AutoAssignResult;
  split: boolean;
  seats: readonly SeatRef[];
}

/** 한 회차의 자동 배정 후보 전체(판매 대상 등급 ID와 휠체어석 수를 함께 준다) */
export interface AutoCandidateList {
  groups: readonly AutoCandidateGroup[];
  /** 판매 대상 등급 ID(문자 코드 순) */
  tiers: readonly string[];
  /** 등급 ID → 판매 대상 휠체어석 수(희망 조건 검사용) */
  wheelchairSeats: ReadonlyMap<string, number>;
}

/** SeatStore.holdAuto의 입력. 부르는 쪽(HoldSeats)이 후보 묶음 페이지와 커서를 맞춰 넘긴다 */
export interface AutoHoldInput {
  eventId: string;
  accountId: string;
  purchaseSessionId: string;
  holdId: string;
  idempotencyKey: string;
  /** 희망 조건의 멱등 지문(autoFingerprint) */
  fingerprint: string;
  /** 희망 매수(분리 후보에서 고를 수) */
  count: number;
  /** 이번 페이지의 후보 묶음(최대 AUTO_CANDIDATE_PAGE개) */
  groups: readonly AutoCandidateGroup[];
  /** 이번 페이지의 첫 후보 묶음 차례(0부터, auto_cur의 값) */
  cursor: number;
  /** auto_cur Hash의 칸 이름(등급·매수·휠체어·분리 조건) */
  cursorField: string;
  /** 1인 한도 */
  limit: number;
  /** 회차 키의 만료 시각(판매 종료 + 1일) */
  keepUntilMs: number;
}

/**
 * SeatStore.holdAuto의 결과. 검사 차례는 HoldResult와 같고, 4·5(경합·방금 놓은 좌석)는 후보마다 본다.
 * - NEXT: 이번 페이지의 후보가 모두 찼다. nextCursor는 다음 페이지의 첫 후보 묶음 차례다(목록 끝을 넘으면 0으로 돌려준다).
 * - OK·IDEM_REPLAY: seatIndexes는 잡은 좌석 색인(연석이면 좌석 차례, 분리면 고른 차례), assignResult는 배정 결과 유형이다.
 */
export type AutoHoldResult =
  | ({ kind: 'OK' } & HeldHold & { seatIndexes: number[]; assignResult: AutoAssignResult; nextCursor: number })
  | ({ kind: 'IDEM_REPLAY' } & HeldHold & { seatIndexes: number[]; assignResult: AutoAssignResult })
  | { kind: 'NOT_READY' }
  | { kind: 'IDEM_REUSED' }
  | { kind: 'PAUSED' }
  | { kind: 'QUOTA_EXCEEDED' }
  | { kind: 'NEXT'; nextCursor: number };

/** 한 번에 Lua에 넘기는 후보 묶음 수(문서 §3 '한 번에 보는 후보는 32개 [가정]까지') */
export const AUTO_CANDIDATE_PAGE = 32;
/** 요청 하나가 이어 찾는 페이지 수. S-T19 측정에서 4페이지(128묶음)는 동시 요청의 공유 커서가 앞서면 빈 블록을 놓쳐 32페이지(1,024묶음)로 늘렸다 */
export const AUTO_CURSOR_PAGES = 32;
/** 한 회차의 후보 묶음 상한. 넘으면 커서가 앞쪽만 돌고, 뒤쪽 좌석은 수동 선택으로 넘어간다(5만 석에서도 1MB 안팎) */
export const AUTO_CANDIDATE_MAX = 16_384;
/** 분리 좌석 후보 묶음 하나에 담는 낱개 좌석 수(한 Lua 호출의 비트 확인 상한과 같다) */
export const AUTO_SPLIT_GROUP_MAX = 32;

/** 희망 조건의 멱등 지문. 같은 조건이면 보낸 차례와 관계없이 같은 값이다(좌석 ID가 없으므로 조건 전체를 넣는다) */
export function autoFingerprint(c: AutoCondition): string {
  return createHash('sha256').update(JSON.stringify([c.firstTierId, c.secondTierId ?? null, c.count, c.wheelchair, c.allowSplit]), 'utf8').digest('hex');
}

/** 희망 조건의 업무 규칙 위반(받는 층이 400/422로 가른다) */
export type AutoConditionProblem =
  /** 그 공연에 없는 등급(400 auto-condition-invalid) */
  | 'UNKNOWN_TIER'
  /** 1·2순위 등급이 같다(422 invalid-auto-condition) */
  | 'SAME_TIER'
  /** 매수가 1인 한도나 좌석 수 상한을 넘는다(422 purchase-limit-exceeded) */
  | 'COUNT_OVER_LIMIT'
  /** 휠체어석이 필요한데 그 등급에 휠체어석이 없다(422 invalid-auto-condition) */
  | 'NO_WHEELCHAIR_SEATS';

/**
 * 희망 조건을 판과 회차 설정으로 검사한다. 등급이 판에 없으면 UNKNOWN_TIER, 1·2순위가 같으면 SAME_TIER,
 * 매수가 1인 한도·MAX_SEATS를 넘으면 COUNT_OVER_LIMIT, 휠체어석이 필요한데 조건의 등급에 휠체어석이 없으면 NO_WHEELCHAIR_SEATS다.
 * @param tiers 판매 대상 등급 ID
 * @param wheelchairSeats 등급 ID → 판매 대상 휠체어석 수
 * @param perAccountLimit 회차 1인 한도
 */
export function autoConditionProblem(c: AutoCondition, tiers: ReadonlySet<string>, wheelchairSeats: ReadonlyMap<string, number>, perAccountLimit: number): AutoConditionProblem | undefined {
  if (!tiers.has(c.firstTierId)) return 'UNKNOWN_TIER';
  if (c.secondTierId !== undefined && !tiers.has(c.secondTierId)) return 'UNKNOWN_TIER';
  if (c.secondTierId !== undefined && c.secondTierId === c.firstTierId) return 'SAME_TIER';
  if (!Number.isSafeInteger(c.count) || c.count < 1 || c.count > MAX_SEATS || c.count > perAccountLimit) return 'COUNT_OVER_LIMIT';
  if (c.wheelchair) {
    if ((wheelchairSeats.get(c.firstTierId) ?? 0) === 0) return 'NO_WHEELCHAIR_SEATS';
    if (c.secondTierId !== undefined && (wheelchairSeats.get(c.secondTierId) ?? 0) === 0) return 'NO_WHEELCHAIR_SEATS';
  }
  return undefined;
}

/** 좌석의 선호 차례: 구역 색인 → 구역 안 거리 → 색인(모두 오름차순). 같은 입력이면 늘 같은 답이다 */
const byPreference = (a: SeatRef, b: SeatRef): number => a.sectionIndex - b.sectionIndex || a.seatOffset - b.seatOffset || a.index - b.index;

/**
 * 판매 대상 좌석들로 자동 배정 후보를 만든다.
 * - 1순위 연석 블록 → (분리 허용 시) 1순위 분리 후보 → 2순위 연석 블록 → (분리 허용 시) 2순위 분리 후보 차례다.
 * - 연석 블록은 같은 구역에서 구역 안 거리가 1씩 이어지는 좌석들이다. 블록 시작을 한 칸씩 옮기며 만든다(찾는 쪽이 비트로 거른다).
 * - 분리 후보는 등급 좌석을 선호 차례로 32개씩 묶는다. 한 묶음에서 희망 매수만큼 빈 좌석을 고른다.
 * - 휠체어 조건이 참이면 휠체어석만, 거짓이면 휠체어석을 뺀다.
 * - 후보가 AUTO_CANDIDATE_MAX를 넘으면 앞에서 자른다(커서가 앞쪽만 돌고 뒤쪽은 수동 선택으로 간다).
 * @param seats 판매 대상 좌석(판매 제외석 없음)
 * @param c 검사한 희망 조건
 * @param tiers 판매 대상 등급 ID
 */
export function autoCandidatesOf(seats: readonly SeatRef[], c: AutoCondition, tiers: ReadonlySet<string>): AutoCandidateList {
  const byTier = new Map<string, SeatRef[]>();
  for (const s of seats) {
    if (!tiers.has(s.tierId)) continue;
    if (c.wheelchair ? s.wheelchair !== true : s.wheelchair === true) continue;
    const list = byTier.get(s.tierId);
    if (list) list.push(s);
    else byTier.set(s.tierId, [s]);
  }
  for (const list of byTier.values()) list.sort(byPreference);
  const groups: AutoCandidateGroup[] = [];
  const addFull = (tier: string, result: AutoAssignResult): void => {
    const list = byTier.get(tier);
    if (!list || list.length < c.count) return;
    let start = 0;
    while (start + c.count <= list.length && groups.length < AUTO_CANDIDATE_MAX) {
      const first = list[start]!;
      const block = [first];
      let ok = true;
      for (let k = 1; k < c.count; k++) {
        const next = list[start + k]!;
        if (next.sectionIndex !== first.sectionIndex || next.seatOffset !== first.seatOffset + k) {
          ok = false;
          start += k;
          break;
        }
        block.push(next);
      }
      if (ok) {
        groups.push({ assignResult: result, split: false, seats: block });
        start += 1;
      }
    }
  };
  const addSplit = (tier: string, result: AutoAssignResult): void => {
    const list = byTier.get(tier);
    if (!list || list.length < c.count) return;
    for (let start = 0; start < list.length && groups.length < AUTO_CANDIDATE_MAX; start += AUTO_SPLIT_GROUP_MAX) {
      groups.push({ assignResult: result, split: true, seats: list.slice(start, start + AUTO_SPLIT_GROUP_MAX) });
    }
  };
  addFull(c.firstTierId, 'FIRST');
  if (c.allowSplit && c.count > 1) addSplit(c.firstTierId, 'FIRST_SPLIT');
  if (c.secondTierId !== undefined) {
    addFull(c.secondTierId, 'SECOND');
    if (c.allowSplit && c.count > 1) addSplit(c.secondTierId, 'SECOND_SPLIT');
  }
  return { groups: groups.slice(0, AUTO_CANDIDATE_MAX), tiers: [...tiers].sort(), wheelchairSeats: wheelchairSeatsByTier(seats, tiers) };
}

/** 후보 목록에서 등급 ID별 휠체어석 수를 센다(희망 조건 검사용) */
export function wheelchairSeatsByTier(seats: readonly SeatRef[], tiers: ReadonlySet<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of seats) {
    if (!tiers.has(s.tierId) || s.wheelchair !== true) continue;
    counts.set(s.tierId, (counts.get(s.tierId) ?? 0) + 1);
  }
  return counts;
}
