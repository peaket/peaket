// 스캐너 승인(휴대폰 쪽) 흐름(SCR-051, d5 §5.27, docs/features/identity.md §6.1 '휴대폰 화면 실제 연결'·'승인 화면의 파트너 이름',
// BUILD_ORDER F-05-7 = GAT-230, ADR-0362 결정 8, I-T62·I-T92). fetch·잠금은 밖에서 넣는다(browser.ts). 경로 별칭 없이 상대 경로로 가져온다(node 시험·실제 서버 연결 시험).
// ① 조회 POST /v1/device-approval-lookups(확인 코드는 본문으로만) → 배정마다 회차 공개 요약으로 배정 파트너 상호·공연명·회차 시작을 읽는다.
//    요약을 못 읽어도 승인은 된다(동의를 받는 화면이 아니다, 결정 3). 조회 403 세 가지는 이유만 보인다(기기 정보·코드·배정·버튼 없음)
// ② 사람이 [승인]·[거부]를 누를 때만 POST /v1/device-approvals를 보낸다(조회만으로는 승인 요청을 보내지 않는다, ASVS 7.6.2)
// 화면 상태 이름은 d5 §5.27 상태 표의 이름 그대로다.
import { readEventSummaries, type EventSummaryReader } from '../../entities/event-summary/index.ts';
import { STAFF_ROLE_LABEL, staffValidCompactRangeText, staffValidRangeText, staffValidTimeRangeText, staffWhenText, type StaffRole } from '../../entities/staff-assignment/index.ts';
import { createFanCaller, type FetchLike, problemTypeOf } from '../../shared/lib/fan-call.ts';

/** 조회 200의 배정 한 줄(openapi StaffAssignment 가운데 화면이 쓰는 칸) */
export interface ApprovalAssignment {
  assignmentId: string;
  eventId: string;
  role: StaffRole;
  validFrom: string;
  validUntil: string;
}

/** 조회 200(openapi DeviceApprovalView). 배정 파트너 이름은 싣지 않는다 */
export interface ApprovalLookup {
  deviceName: string;
  userCode: string;
  assignments: ApprovalAssignment[];
  canProxy: boolean;
}

/** 조회 403의 까닭(d5 §5.27 '권한 없음' 세 상태) */
export type LookupDenyReason = 'staff-assignment-missing' | 'other-partner-device' | 'outside-staff-hours';

export type ApprovalLookupAnswer =
  | { kind: 'ok'; request: ApprovalLookup }
  | { kind: 'denied'; reason: LookupDenyReason }
  | { kind: 'expired' }
  | { kind: 'limited' }
  | { kind: 'login' }
  | { kind: 'error' };

export type DecideAnswer =
  | { kind: 'done' }
  | { kind: 'denied'; reason: LookupDenyReason }
  | { kind: 'proxy-forbidden' }
  | { kind: 'conflict' }
  | { kind: 'expired' }
  | { kind: 'limited' }
  | { kind: 'login' }
  | { kind: 'error' };

export interface StaffApprovalApi {
  lookup(userCode: string): Promise<ApprovalLookupAnswer>;
  decide(i: { userCode: string; decision: 'APPROVE' | 'DENY'; assignmentId?: string; proxy?: boolean }): Promise<DecideAnswer>;
}

const DENY_TYPES: readonly LookupDenyReason[] = ['staff-assignment-missing', 'other-partner-device', 'outside-staff-hours'];
const isDenyType = (t: string): t is LookupDenyReason => (DENY_TYPES as readonly string[]).includes(t);
const isRole = (v: unknown): v is StaffRole => v === 'gate_lead' || v === 'gate_staff';
const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/** 조회 200 본문 → ApprovalLookup. 모양이 틀리거나 배정이 비었으면 null(200이면 배정이 하나 이상이다, openapi DeviceApprovalView) */
export function approvalLookupOf(body: unknown): ApprovalLookup | null {
  const b = body as { deviceName?: unknown; userCode?: unknown; assignments?: unknown; canProxy?: unknown } | null;
  if (!b || typeof b !== 'object' || typeof b.deviceName !== 'string' || typeof b.userCode !== 'string' || !Array.isArray(b.assignments) || b.assignments.length === 0) return null;
  const assignments: ApprovalAssignment[] = [];
  for (const raw of b.assignments) {
    const a = raw as Partial<Record<keyof ApprovalAssignment, unknown>> | null;
    if (!a || typeof a.assignmentId !== 'string' || typeof a.eventId !== 'string' || !isRole(a.role) || !isTime(a.validFrom) || !isTime(a.validUntil)) return null;
    assignments.push({ assignmentId: a.assignmentId, eventId: a.eventId, role: a.role, validFrom: a.validFrom, validUntil: a.validUntil });
  }
  return { deviceName: b.deviceName, userCode: b.userCode, assignments, canProxy: b.canProxy === true };
}

/** origin: API 출처(gw-fan). lock: 토큰 갱신을 창끼리 하나씩 */
export function createStaffApprovalApi(o: { origin: string; fetch: FetchLike; lock?: <T>(fn: () => Promise<T>) => Promise<T> }): StaffApprovalApi {
  const fan = createFanCaller(o);
  const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  async function run<T extends { kind: string }>(path: string, init: RequestInit, read: (r: Response) => Promise<T>): Promise<T | { kind: 'login' } | { kind: 'error' }> {
    let r: T | 'login' | 'unavailable';
    try {
      r = await fan.call(path, init, read);
    } catch {
      return { kind: 'error' };
    }
    if (r === 'login') return { kind: 'login' };
    return r === 'unavailable' ? { kind: 'error' } : r;
  }
  return {
    lookup: (userCode) =>
      run('/v1/device-approval-lookups', json({ userCode }), async (res): Promise<ApprovalLookupAnswer> => {
        if (res.status === 200) {
          const req = approvalLookupOf(await res.json());
          return req ? { kind: 'ok', request: req } : { kind: 'error' };
        }
        if (res.status === 404) return { kind: 'expired' };
        if (res.status === 429) return { kind: 'limited' };
        const type = await problemTypeOf(res);
        if (res.status === 403 && isDenyType(type)) return { kind: 'denied', reason: type };
        return { kind: 'error' };
      }),
    decide: (i) =>
      run(
        '/v1/device-approvals',
        json({ userCode: i.userCode, decision: i.decision, ...(i.assignmentId !== undefined ? { assignmentId: i.assignmentId } : {}), ...(i.proxy ? { proxy: true } : {}) }),
        async (res): Promise<DecideAnswer> => {
          if (res.status === 204) return { kind: 'done' };
          if (res.status === 404) return { kind: 'expired' };
          if (res.status === 429) return { kind: 'limited' };
          const type = await problemTypeOf(res);
          if (res.status === 409 && type === 'device-approval-conflict') return { kind: 'conflict' };
          if (res.status === 403 && type === 'proxy-approval-forbidden') return { kind: 'proxy-forbidden' };
          if (res.status === 403 && isDenyType(type)) return { kind: 'denied', reason: type };
          return { kind: 'error' };
        },
      ),
  };
}

/** SCR-051 실제 흐름의 화면 상태(d5 §5.27 상태 이름). '불러오지 못함'은 d5에 없는 조회 실패(5xx·연결 끊김)다 */
export type ApprovalLiveState =
  | '조회 중'
  | '승인 대기'
  | '배정 고르기'
  | '파트너 이름을 읽지 못함'
  | '로그인 필요'
  | '승인됨'
  | '거부함'
  | '코드 만료'
  | '시도 초과'
  | '권한 없음 · 배정 없음'
  | '권한 없음 · 다른 파트너 기기'
  | '권한 없음 · 운영 시간 밖'
  | '권한 없음 · 대리 승인'
  | '다른 승인이 먼저 처리됨'
  | '불러오지 못함';

const DENY_STATE: Record<LookupDenyReason, ApprovalLiveState> = {
  'staff-assignment-missing': '권한 없음 · 배정 없음',
  'other-partner-device': '권한 없음 · 다른 파트너 기기',
  'outside-staff-hours': '권한 없음 · 운영 시간 밖',
};

/** 화면에 그릴 배정 한 줄(공연명은 회차 공개 요약에서, 못 읽으면 유효 시간 짧은 줄) */
export interface ApprovalAssignmentView {
  assignmentId: string;
  role: StaffRole;
  /** 하나일 때 카드 첫 줄: 'LUMEN 콘서트 10/25(일) 18:00' 또는 '10/25 13:30~22:00 · 현장 책임자' */
  title: string;
  /** 하나일 때 둘째 줄 '현장 책임자 · 권한 유효 13:30 ~ 22:00'. 요약을 못 읽었으면 없다 */
  meta?: string;
  /** 둘 이상일 때 고르기 후보 글 */
  label: string;
  /** '10/25(일) 13:30 ~ 22:00' */
  validText: string;
}

export interface ApprovalView {
  deviceName: string;
  code: string;
  canProxy: boolean;
  /** 배정 파트너 상호. 어느 회차 요약도 못 읽었으면 null('이름을 불러오지 못했습니다') */
  partnerName: string | null;
  assignments: ApprovalAssignmentView[];
}

export interface ApprovalLoad {
  state: ApprovalLiveState;
  view?: ApprovalView;
}

/**
 * 조회 → 배정마다 회차 공개 요약. 코드가 없으면(조각도 탭 저장소 값도 없음·10분 지남) 코드 만료와 같은 화면이다.
 * 배정이 둘 이상이면 배정 고르기, 하나면 승인 대기, 요약을 하나도 못 읽었으면 파트너 이름을 읽지 못함(승인은 된다)
 */
export async function loadApproval(o: { api: Pick<StaffApprovalApi, 'lookup'>; events: EventSummaryReader; code: string | null }): Promise<ApprovalLoad> {
  if (!o.code) return { state: '코드 만료' };
  const r = await o.api.lookup(o.code);
  if (r.kind === 'login') return { state: '로그인 필요' };
  if (r.kind === 'expired') return { state: '코드 만료' };
  if (r.kind === 'limited') return { state: '시도 초과' };
  if (r.kind === 'denied') return { state: DENY_STATE[r.reason] };
  if (r.kind !== 'ok') return { state: '불러오지 못함' };
  const summaries = await readEventSummaries(o.events, r.request.assignments.map((a) => a.eventId));
  const assignments = r.request.assignments.map((a): ApprovalAssignmentView => {
    const s = summaries.get(a.eventId);
    const role = STAFF_ROLE_LABEL[a.role];
    if (s?.kind === 'ok') {
      const show = `${s.summary.title} ${staffWhenText(s.summary.startsAt)}`;
      return { assignmentId: a.assignmentId, role: a.role, title: show, meta: `${role} · 권한 유효 ${staffValidTimeRangeText(a.validFrom, a.validUntil)}`, label: `${show} · ${role}`, validText: staffValidRangeText(a.validFrom, a.validUntil) };
    }
    const compact = `${staffValidCompactRangeText(a.validFrom, a.validUntil)} · ${role}`;
    return { assignmentId: a.assignmentId, role: a.role, title: compact, label: compact, validText: staffValidRangeText(a.validFrom, a.validUntil) };
  });
  // 받은 배정은 모두 기기의 배정 파트너 회차의 것이라 처음 읽은 상호가 그 파트너 이름이다(d5 §5.27 '파트너 이름')
  const known = r.request.assignments.map((a) => summaries.get(a.eventId)).find((s) => s?.kind === 'ok');
  const partnerName = known?.kind === 'ok' ? known.summary.sellerName : null;
  const view: ApprovalView = { deviceName: r.request.deviceName, code: r.request.userCode, canProxy: r.request.canProxy, partnerName, assignments };
  const state: ApprovalLiveState = assignments.length > 1 ? '배정 고르기' : partnerName === null ? '파트너 이름을 읽지 못함' : '승인 대기';
  return { state, view };
}

/** 승인·거부 결과 → 다음 화면 상태. error는 'retry'(그 자리 안내, 상태는 그대로) */
export function afterDecide(r: DecideAnswer, decision: 'APPROVE' | 'DENY'): ApprovalLiveState | 'retry' | 'login' {
  switch (r.kind) {
    case 'done':
      return decision === 'APPROVE' ? '승인됨' : '거부함';
    case 'denied':
      return DENY_STATE[r.reason];
    case 'proxy-forbidden':
      return '권한 없음 · 대리 승인';
    case 'conflict':
      return '다른 승인이 먼저 처리됨';
    case 'expired':
      return '코드 만료';
    case 'limited':
      return '시도 초과';
    case 'login':
      return 'login';
    default:
      return 'retry';
  }
}

/** 확인 코드 낭독 이름 '확인 코드 W D J B 하이픈 M J H T'(한 글자씩 읽게 한다, d3 SCR-051) */
export function approvalCodeLabel(code: string): string {
  return `확인 코드 ${[...code].map((c) => (c === '-' ? '하이픈' : c)).join(' ')}`;
}
