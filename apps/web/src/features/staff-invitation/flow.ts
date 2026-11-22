// 현장 스태프 초대 수락·거절과 내 현장 배정 목록 흐름(SCR-050·SCR-061, d5 §5.26·§5.35, docs/features/identity.md §6.1 '휴대폰 화면 실제 연결',
// BUILD_ORDER F-05-7 = GAT-230·GAT-240, ADR-0362 결정 1~5·8, I-T91·I-T93).
// fetch·잠금은 밖에서 넣는다(browser.ts). 그래서 이 파일은 node 시험과 실제 서버 연결 시험이 바로 읽는다(경로 별칭 없이 상대 경로).
// ① 조회 POST /v1/staff-invitation-lookups → 회차 공개 요약(eventId)으로 판매자 상호·공연명·회차 시작을 읽는다. 요약을 못 읽으면 수락을 막는다(결정 3)
// ② 수락 POST /v1/staff-invitation-acceptances(조회가 준 consentVersion과 두 동의) ③ 거절 POST /v1/staff-invitation-rejections(확인 줄 뒤, 결정 5)
// ④ 내 배정 GET /v1/staff-assignments(첫 쪽 limit 50, nextCursor로 이어 붙인다)
// 화면 상태 이름은 d5 §5.26·§5.35 상태 표의 이름 그대로다(정본, 문구는 화면 부품이 그 표에서 가져온다).
import { readEventSummaries, type EventSummary, type EventSummaryReader } from '../../entities/event-summary/index.ts';
import { staffAssignmentSelfOf, type StaffAssignmentSelf, type StaffRole } from '../../entities/staff-assignment/index.ts';
import { createFanCaller, type FetchLike, problemTypeOf } from '../../shared/lib/fan-call.ts';
import type { RefreshResult } from '../../shared/lib/token-refresh.ts';

/** 조회 200(openapi StaffInvitationView). partnerName·eventTitle·eventStartsAt은 identity-svc가 채우지 않아 읽지 않는다(결정 1) */
export interface InvitationLookup {
  eventId: string;
  role: StaffRole;
  validFrom: string;
  validUntil: string;
  invitedEmailMasked: string;
  consents: { collection: string; provision: string; consentVersion: string };
}

export type LookupAnswer = { kind: 'ok'; invitation: InvitationLookup } | { kind: 'expired' } | { kind: 'login' } | { kind: 'error' };
export type AcceptAnswer =
  | { kind: 'accepted' }
  | { kind: 'mismatch' }
  | { kind: 'unverified' }
  | { kind: 'need-identity' }
  | { kind: 'assigned' }
  | { kind: 'expired' }
  | { kind: 'consent-missing' }
  | { kind: 'outdated' }
  | { kind: 'login' }
  | { kind: 'error' };
export type RejectAnswer = { kind: 'rejected' } | { kind: 'expired' } | { kind: 'login' } | { kind: 'error' };
export type AssignmentsAnswer = { kind: 'ok'; items: StaffAssignmentSelf[]; nextCursor: string | null } | { kind: 'login' } | { kind: 'error' };

export interface StaffInvitationApi {
  refresh(): Promise<RefreshResult>;
  lookup(inviteToken: string): Promise<LookupAnswer>;
  accept(i: { inviteToken: string; consentVersion: string }): Promise<AcceptAnswer>;
  reject(inviteToken: string): Promise<RejectAnswer>;
  /** 내 현장 배정 한 쪽. cursor가 없으면 첫 쪽 */
  listAssignments(cursor?: string | null): Promise<AssignmentsAnswer>;
}

/** 내 현장 배정 첫 쪽 크기(d5 §5.35, I-T93 ③) */
export const ASSIGNMENTS_PAGE_LIMIT = 50;

const isRole = (v: unknown): v is StaffRole => v === 'gate_lead' || v === 'gate_staff';
const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/** 조회 200 본문 → InvitationLookup. 모양이 틀리면 null */
export function invitationLookupOf(body: unknown): InvitationLookup | null {
  const b = body as Partial<Record<keyof InvitationLookup, unknown>> | null;
  if (!b || typeof b !== 'object' || typeof b.eventId !== 'string' || b.eventId === '' || !isRole(b.role) || !isTime(b.validFrom) || !isTime(b.validUntil)) return null;
  const c = b.consents as Partial<Record<'collection' | 'provision' | 'consentVersion', unknown>> | undefined;
  if (!c || typeof c.collection !== 'string' || typeof c.provision !== 'string' || typeof c.consentVersion !== 'string' || c.consentVersion === '') return null;
  return {
    eventId: b.eventId,
    role: b.role,
    validFrom: b.validFrom,
    validUntil: b.validUntil,
    invitedEmailMasked: typeof b.invitedEmailMasked === 'string' ? b.invitedEmailMasked : '',
    consents: { collection: c.collection, provision: c.provision, consentVersion: c.consentVersion },
  };
}

/** origin: API 출처(gw-fan). lock: 토큰 갱신을 창끼리 하나씩 */
export function createStaffInvitationApi(o: { origin: string; fetch: FetchLike; lock?: <T>(fn: () => Promise<T>) => Promise<T> }): StaffInvitationApi {
  const fan = createFanCaller(o);
  const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  /** 연결 실패·시간 초과(던짐)와 갱신 일시 장애는 error, 갱신 거절은 login */
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
    refresh: fan.refresh,
    lookup: (inviteToken) =>
      run('/v1/staff-invitation-lookups', json({ inviteToken }), async (res): Promise<LookupAnswer> => {
        if (res.status === 410) return { kind: 'expired' };
        if (res.status !== 200) return { kind: 'error' };
        const inv = invitationLookupOf(await res.json());
        return inv ? { kind: 'ok', invitation: inv } : { kind: 'error' };
      }),
    accept: (i) =>
      run(
        '/v1/staff-invitation-acceptances',
        // 역할은 초대가 정한다(본문으로 보내지 않는다). 두 동의는 화면이 두 칸을 모두 체크했을 때만 부르므로 true다
        json({ inviteToken: i.inviteToken, consentCollection: true, consentProvision: true, consentVersion: i.consentVersion }),
        async (res): Promise<AcceptAnswer> => {
          if (res.status === 200) return { kind: 'accepted' };
          if (res.status === 409) return { kind: 'assigned' };
          if (res.status === 410) return { kind: 'expired' };
          const type = await problemTypeOf(res);
          if (res.status === 403 && type === 'staff-invitation-email-mismatch') return { kind: 'mismatch' };
          if (res.status === 403 && type === 'staff-invitation-email-unverified') return { kind: 'unverified' };
          if (res.status === 403 && type === 'identity-verification-required') return { kind: 'need-identity' };
          if (res.status === 422 && type === 'consent-version-outdated') return { kind: 'outdated' };
          if (res.status === 422 && type === 'consent-required') return { kind: 'consent-missing' };
          return { kind: 'error' };
        },
      ),
    reject: (inviteToken) =>
      run('/v1/staff-invitation-rejections', json({ inviteToken }), async (res): Promise<RejectAnswer> => {
        if (res.status === 204) return { kind: 'rejected' };
        if (res.status === 410) return { kind: 'expired' };
        return { kind: 'error' };
      }),
    listAssignments: (cursor) => {
      const q = new URLSearchParams({ limit: String(ASSIGNMENTS_PAGE_LIMIT) });
      if (cursor) q.set('cursor', cursor);
      return run(`/v1/staff-assignments?${q.toString()}`, { method: 'GET', headers: { accept: 'application/json' } }, async (res): Promise<AssignmentsAnswer> => {
        if (res.status !== 200) return { kind: 'error' };
        const b = (await res.json()) as { items?: unknown; nextCursor?: unknown };
        if (!Array.isArray(b.items)) return { kind: 'error' };
        const items = b.items.map(staffAssignmentSelfOf);
        if (items.some((x) => x === null)) return { kind: 'error' };
        return { kind: 'ok', items: items as StaffAssignmentSelf[], nextCursor: typeof b.nextCursor === 'string' && b.nextCursor !== '' ? b.nextCursor : null };
      });
    },
  };
}

/** 동의 카드의 고지 한 줄 */
export interface ConsentLine {
  term: string;
  detail: string;
}

/**
 * 서버 고지 원문 → 줄(결정 2: 줄마다 `이름: 내용`, 줄바꿈으로 나눔). 화면은 이 줄을 글자로만 보인다(HTML로 해석하지 않는다).
 * 빈 줄은 뺀다. `이름: `이 없는 줄은 이름 없이 내용만 둔다(문안을 화면이 고쳐 쓰지 않는다)
 */
export function consentLinesOf(text: string): ConsentLine[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((l) => {
      const i = l.indexOf(':');
      return i > 0 ? { term: l.slice(0, i).trim(), detail: l.slice(i + 1).trim() } : { term: '', detail: l };
    });
}

/** SCR-050 실제 흐름의 화면 상태(d5 §5.26 상태 이름). '불러오지 못함'은 d5에 없는 조회 실패(5xx·연결 끊김)다 */
export type InvitationLiveState =
  | '조회 중'
  | '동의 전'
  | '파트너 이름을 읽지 못함'
  | '로그인 필요'
  | '만료'
  | '이메일 불일치'
  | '검증 이메일 없음'
  | '본인확인 필요'
  | '이미 배정'
  | '동의 누락'
  | '수락 완료'
  | '거절함'
  | '불러오지 못함';

export interface InvitationLoad {
  state: InvitationLiveState;
  invitation?: InvitationLookup;
  /** 회차 공개 요약(받는 자 상호·공연명·회차 시작). 못 읽었으면 없다 */
  summary?: EventSummary;
}

/** 수락할 수 있는 상태인가(결정 3: 받는 자 상호를 읽어야 수락이 켜진다. 두 동의 체크는 화면이 따로 본다) */
export const canAcceptIn = (load: InvitationLoad): boolean => load.state === '동의 전' && !!load.invitation && !!load.summary;

/**
 * 조회 → 회차 공개 요약. 토큰이 없으면(조각도 탭 저장소 값도 없음·10분 지남) 만료와 같은 화면이다.
 * 조회 401(갱신도 401)은 로그인 필요, 410은 만료, 그 밖 실패는 불러오지 못함. 요약이 404·410·닿지 않음이면 파트너 이름을 읽지 못함(수락 꺼짐)
 */
export async function loadInvitation(o: { api: Pick<StaffInvitationApi, 'lookup'>; events: EventSummaryReader; token: string | null }): Promise<InvitationLoad> {
  if (!o.token) return { state: '만료' };
  const r = await o.api.lookup(o.token);
  if (r.kind === 'login') return { state: '로그인 필요' };
  if (r.kind === 'expired') return { state: '만료' };
  if (r.kind !== 'ok') return { state: '불러오지 못함' };
  const s = (await readEventSummaries(o.events, [r.invitation.eventId])).get(r.invitation.eventId);
  return s?.kind === 'ok' ? { state: '동의 전', invitation: r.invitation, summary: s.summary } : { state: '파트너 이름을 읽지 못함', invitation: r.invitation };
}

/** 수락 결과 → 다음 화면 상태. outdated는 'reload'(고지를 다시 조회해 체크를 풀고 새 문안을 보인다), error는 'retry'(그 자리 안내, 상태는 그대로) */
export function afterAccept(r: AcceptAnswer): InvitationLiveState | 'reload' | 'retry' | 'login' {
  switch (r.kind) {
    case 'accepted':
      return '수락 완료';
    case 'mismatch':
      return '이메일 불일치';
    case 'unverified':
      return '검증 이메일 없음';
    case 'need-identity':
      return '본인확인 필요';
    case 'assigned':
      return '이미 배정';
    case 'expired':
      return '만료';
    case 'consent-missing':
      return '동의 누락';
    case 'outdated':
      return 'reload';
    case 'login':
      return 'login';
    default:
      return 'retry';
  }
}

/** 거절 결과 → 다음 화면 상태(204 거절함, 410 만료). error는 그 자리 안내 */
export function afterReject(r: RejectAnswer): InvitationLiveState | 'retry' | 'login' {
  if (r.kind === 'rejected') return '거절함';
  if (r.kind === 'expired') return '만료';
  return r.kind === 'login' ? 'login' : 'retry';
}

/** 수락·거절이 실패했을 때의 그 자리 안내(d5에 없는 일시 장애) */
export const STAFF_RETRY_TEXT = '지금은 처리할 수 없습니다. 잠시 뒤 다시 시도해 주세요';
