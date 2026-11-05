// 계정 설정의 로그인 수단 연결·해제 흐름(SCR-040 ①②③, docs/features/identity.md §2.1 '설정의 로그인 수단 연결·해제의 첫 구현', BUILD_ORDER BOT-041, I-T33·I-T34).
// 브라우저 기능(fetch·sessionStorage·양식 제출)은 밖에서 넣는다(browser.ts). 그래서 이 파일은 node 시험(flow.test.mjs)으로 본다.
// ① 목록(GET /v1/identity/providers) ② 해제·추가 전에 재인증: 탭 저장소에 할 일을 남기고 POST /reauth/{제공자}로 옮긴다
// ③ 돌아오면 할 일이 있을 때만 POST /reauth/token으로 토큰을 받아 해제(DELETE /v1/identity/providers/{p})나 추가(POST /link/{p})를 한다
// ④ 계정 합치기(SCR-040 ④~⑥, identity §2.1 '계정 병합의 첫 구현' 화면, BUILD_ORDER BOT-043): 제안 조회(GET /v1/identity/merge-proposals/{id}),
//    재인증 뒤 확정(POST …/confirmation, X-Reauth-Token). 요약 글(mergeView)도 여기서 만든다
import { REAUTH_EXPIRED, type ReauthFailure, reauthFailureOf } from '../../shared/lib/reauth-failure.ts';
import { refreshOnce, type RefreshResult } from '../../shared/lib/token-refresh.ts';

export type { RefreshResult };
/** 재인증 토큰을 쓰는 요청의 403(해제·추가·합치기 확정): 5분이 지난 때 말고 이미 쓴 토큰에도 오므로 넓게 쓴다(BOT-036이 넘긴 것) */
const REAUTH_EXPIRED_RETRY = `${REAUTH_EXPIRED}. 처음부터 다시 시도해 주세요`;

export const PROVIDERS = ['kakao', 'naver', 'google'] as const;
export type Provider = (typeof PROVIDERS)[number];
/** 탭 저장소의 '재인증 뒤 할 일'. 값은 {action, provider, at} JSON */
export const PENDING_KEY = 'peaket.providers.pending';
/** 할 일을 믿는 시간 [가정]: 재인증 결과 쿠키(1분)와 제공자 화면에서 머무는 시간을 넉넉히 덮는다(탈퇴의 표시와 같다) */
export const PENDING_TTL_MS = 10 * 60_000;
export const RETURN_TO = '/my/settings/providers';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface StorageLike {
  get(k: string): string | null;
  set(k: string, v: string): void;
  remove(k: string): void;
}

export interface LinkedMethod {
  provider: Provider;
  linkedAt: string;
  lastLoginAt: string | null;
}
export type ListAnswer = { kind: 'ok'; methods: LinkedMethod[] } | { kind: 'login' } | { kind: 'error' };
export type UnlinkAnswer = { kind: 'done' } | { kind: 'last' } | { kind: 'missing' } | { kind: 'reauth' } | { kind: 'login' } | { kind: 'error' };
/** 실패면 이유(오래된 인증·계정 불일치 등, 화면은 shared/lib/reauth-failure의 이유별 문구, BOT-041이 넘긴 것) */
export type ReauthAnswer = { kind: 'token'; token: string } | { kind: 'failed'; reason: ReauthFailure };
export type Pending =
  | { action: 'unlink' | 'add'; provider: Provider; at: number }
  /** 계정 합치기: provider는 다시 로그인한 제공자(확인 창의 '카카오로 다시 로그인했습니다') */
  | { action: 'merge'; provider: Provider; proposalId: string; at: number };

/** openapi MergeProposal.blockers */
export const MERGE_BLOCKERS = ['ACTIVE_PURCHASE_SESSION', 'PENDING_PAYMENT', 'QUOTA_EXCEEDED', 'BOTH_VERIFIED', 'WITHDRAWAL_IN_PROGRESS', 'APPEAL_PENDING', 'ENTRY_STARTED'] as const;
export type MergeBlocker = (typeof MERGE_BLOCKERS)[number];
/** 화면의 다섯 범주(d5 §5.22 blocked, entities/provider MergeBlockerCode와 같은 이름) */
export type MergeCategory = 'ACTIVE_PURCHASE' | 'QUOTA_EXCEEDED' | 'BOTH_VERIFIED' | 'WITHDRAWAL_OR_APPEAL' | 'ENTRY_STARTED';
export interface MergeProposalView {
  id: string;
  status: 'PROPOSED' | 'BLOCKED';
  blockers: MergeBlocker[];
  moved: { providers: number; wishes: number; subscriptions: number; addresses: number; orders: number };
  /** 끝나는 시각을 기기 시계 값으로 옮긴 유닉스 밀리초(서버 시각 − 보정 시계 차). 남은 시간·만료 전환은 기기 시계(Date.now)와 견준다(BOT-043이 넘긴 것) */
  expiresAt: number;
  newProvider: Provider;
  requesterRole: 'PRIMARY' | 'MERGED';
  primaryVerified: boolean;
}
export type MergeAnswer = { kind: 'ok'; proposal: MergeProposalView } | { kind: 'expired' } | { kind: 'login' } | { kind: 'error' };
export type ConfirmMergeAnswer =
  | { kind: 'accepted' }
  | { kind: 'blocked'; blockers: MergeBlocker[] }
  | { kind: 'invariant' }
  | { kind: 'expired' }
  | { kind: 'reauth' }
  | { kind: 'unavailable' }
  | { kind: 'login' }
  | { kind: 'error' };

/** 병합 제안 ID(128비트 난수의 base64url 22자) */
export const isMergeProposalId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{22}$/.test(v);
const isBlocker = (v: unknown): v is MergeBlocker => typeof v === 'string' && (MERGE_BLOCKERS as readonly string[]).includes(v);
const count = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);

export const isProvider = (v: unknown): v is Provider => typeof v === 'string' && (PROVIDERS as readonly string[]).includes(v);

async function problemType(r: Response): Promise<string> {
  try {
    const b = (await r.json()) as { type?: unknown };
    return typeof b.type === 'string' ? (b.type.split('/').pop() ?? '') : '';
  } catch {
    return '';
  }
}

/** 보정 시계(shared/lib/clock Clock)의 쓰는 모양만 */
export interface ClockLike {
  now(): number;
  addDateHeader(date: string | null | undefined, sentMono: number, receivedMono: number): boolean;
}

/**
 * origin: API 출처(gw-fan). 재인증 결과 받기(/reauth/token)는 이 화면과 같은 출처다(앱 서버).
 * clock: 보정 시계(docs/frontend.md §3.3). 주면 병합 제안 응답의 Date를 표본으로 더하고, 제안의 끝 시각을 기기 시계 값으로 옮긴다.
 * wall·mono: 기기 벽시계와 단조 시계(시험이 바꾼다)
 */
export function createLoginMethodsApi(o: {
  origin: string;
  fetch: FetchLike;
  lock?: <T>(fn: () => Promise<T>) => Promise<T>;
  clock?: ClockLike;
  wall?: () => number;
  mono?: () => number;
}) {
  const lock = o.lock ?? (<T>(fn: () => Promise<T>) => fn());
  const wall = o.wall ?? (() => Date.now());
  const mono = o.mono ?? (() => performance.now());
  const url = (p: string) => `${o.origin}${p}`;
  /** 401만 거절(rejected)이고 연결 끊김·5xx는 일시 장애(unavailable)다(docs/frontend.md §4.1 '401', 새 맥락 리뷰) */
  const refresh = (): Promise<RefreshResult> => lock(() => refreshOnce(o.fetch, url('/v1/identity/access-tokens')));
  /**
   * 보내고 401이면 갱신 뒤 한 번 더. 갱신이 401로 거절되거나 다시 401이면 login, 갱신이 일시 장애면 unavailable이다.
   * onSend: 요청을 실제로 보낼 때마다(다시 보낸 것 포함) 부른다(시계 표본의 보낸 시각)
   */
  async function call(path: string, init: RequestInit, onSend?: () => void): Promise<Response | 'login' | 'unavailable'> {
    const send = () => {
      onSend?.();
      return o.fetch(url(path), { credentials: 'include', cache: 'no-store', ...init });
    };
    const first = await send();
    if (first.status !== 401) return first;
    const refreshed = await refresh();
    if (refreshed === 'rejected') return 'login';
    if (refreshed !== 'ok') return 'unavailable';
    const second = await send();
    return second.status === 401 ? 'login' : second;
  }
  return {
    refresh,
    async list(): Promise<ListAnswer> {
      let r: Response | 'login' | 'unavailable';
      try {
        r = await call('/v1/identity/providers', { method: 'GET', headers: { accept: 'application/json' } });
      } catch {
        return { kind: 'error' };
      }
      if (r === 'login') return { kind: 'login' };
      // 일시 장애도 오류(화면은 안내와 [다시 불러오기])
      if (r === 'unavailable' || r.status !== 200) return { kind: 'error' };
      try {
        const b = (await r.json()) as { providers?: unknown };
        const rows = Array.isArray(b.providers) ? b.providers : [];
        const methods = rows
          .map((x) => x as { provider?: unknown; linkedAt?: unknown; lastLoginAt?: unknown })
          .filter((x) => isProvider(x.provider) && typeof x.linkedAt === 'string')
          .map((x) => ({ provider: x.provider as Provider, linkedAt: x.linkedAt as string, lastLoginAt: typeof x.lastLoginAt === 'string' ? x.lastLoginAt : null }));
        return methods.length ? { kind: 'ok', methods } : { kind: 'error' };
      } catch {
        return { kind: 'error' };
      }
    },
    async unlink(provider: Provider, token: string): Promise<UnlinkAnswer> {
      let r: Response | 'login' | 'unavailable';
      try {
        r = await call(`/v1/identity/providers/${provider}`, { method: 'DELETE', headers: { accept: 'application/json', 'x-reauth-token': token } });
      } catch {
        return { kind: 'error' };
      }
      if (r === 'login') return { kind: 'login' };
      if (r === 'unavailable') return { kind: 'error' };
      if (r.status === 204) return { kind: 'done' };
      if (r.status === 404) return { kind: 'missing' };
      if (r.status === 409 && (await problemType(r)) === 'last-login-method') return { kind: 'last' };
      if (r.status === 403) return { kind: 'reauth' };
      return { kind: 'error' };
    },
    async getMerge(id: string): Promise<MergeAnswer> {
      if (!isMergeProposalId(id)) return { kind: 'expired' };
      let r: Response | 'login' | 'unavailable';
      // 시계 표본의 보낸 시각은 실제로 보낸 요청마다 잰다(401 → 갱신 → 다시 보냈으면 마지막으로 보낸 때, 새 맥락 리뷰)
      let sent = mono();
      try {
        r = await call(`/v1/identity/merge-proposals/${id}`, { method: 'GET', headers: { accept: 'application/json' } }, () => (sent = mono()));
      } catch {
        return { kind: 'error' };
      }
      if (r === 'login') return { kind: 'login' };
      if (r === 'unavailable') return { kind: 'error' };
      if (r.status === 404) return { kind: 'expired' };
      if (r.status !== 200) return { kind: 'error' };
      // 캐시하지 않는 응답의 Date를 보정 시계 표본으로 더한다(읽지 못하면 앞서 모은 보정값, 없으면 기기 시계 그대로, frontend §3.3)
      o.clock?.addDateHeader(r.headers.get('date'), sent, mono());
      /** 서버 시각 − 기기 시각 */
      const skew = o.clock ? o.clock.now() - wall() : 0;
      try {
        const b = (await r.json()) as Record<string, unknown>;
        const moved = (b.moved ?? {}) as Record<string, unknown>;
        const blockers = Array.isArray(b.blockers) ? b.blockers : [];
        const expiresAt = typeof b.expiresAt === 'string' ? Date.parse(b.expiresAt) : NaN;
        if ((b.status !== 'PROPOSED' && b.status !== 'BLOCKED') || !blockers.every(isBlocker) || !isProvider(b.newProvider) || (b.requesterRole !== 'PRIMARY' && b.requesterRole !== 'MERGED') || Number.isNaN(expiresAt)) {
          return { kind: 'error' };
        }
        return {
          kind: 'ok',
          proposal: {
            id,
            status: b.status,
            blockers,
            moved: { providers: count(moved.providers), wishes: count(moved.wishes), subscriptions: count(moved.subscriptions), addresses: count(moved.addresses), orders: count(moved.orders) },
            expiresAt: expiresAt - skew,
            newProvider: b.newProvider,
            requesterRole: b.requesterRole,
            primaryVerified: b.primaryVerified === true,
          },
        };
      } catch {
        return { kind: 'error' };
      }
    },
    async confirmMerge(id: string, token: string): Promise<ConfirmMergeAnswer> {
      if (!isMergeProposalId(id)) return { kind: 'expired' };
      let r: Response | 'login' | 'unavailable';
      try {
        r = await call(`/v1/identity/merge-proposals/${id}/confirmation`, { method: 'POST', headers: { accept: 'application/json', 'x-reauth-token': token } });
      } catch {
        // 연결이 끊겨도 재인증 토큰과 확인 창을 둔다(서버가 처리했으면 다시 누를 때 404 만료, 새 맥락 리뷰)
        return { kind: 'unavailable' };
      }
      if (r === 'login') return { kind: 'login' };
      if (r === 'unavailable') return { kind: 'unavailable' };
      if (r.status === 202) return { kind: 'accepted' };
      if (r.status === 404) return { kind: 'expired' };
      if (r.status === 403) return { kind: 'reauth' };
      if (r.status === 503) return { kind: 'unavailable' };
      if (r.status === 409) {
        try {
          const b = (await r.json()) as { type?: unknown; blockers?: unknown };
          const type = typeof b.type === 'string' ? (b.type.split('/').pop() ?? '') : '';
          if (type === 'merge-invariant-violated') return { kind: 'invariant' };
          if (type === 'merge-blocked') return { kind: 'blocked', blockers: (Array.isArray(b.blockers) ? b.blockers : []).filter(isBlocker) };
        } catch {
          return { kind: 'error' };
        }
      }
      return { kind: 'error' };
    },
    async pickupReauth(): Promise<ReauthAnswer> {
      try {
        const r = await o.fetch('/reauth/token', { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
        // 실패는 이유를 남긴다(탈퇴 화면과 같은 이유별 문구, identity §2.1, BOT-041이 넘긴 것)
        if (r.status !== 200) return { kind: 'failed', reason: reauthFailureOf(await problemType(r)) };
        const b = (await r.json()) as { reauthToken?: unknown };
        return typeof b.reauthToken === 'string' && b.reauthToken ? { kind: 'token', token: b.reauthToken } : { kind: 'failed', reason: 'failed' };
      } catch {
        return { kind: 'failed', reason: 'failed' };
      }
    },
  };
}
export type LoginMethodsApi = ReturnType<typeof createLoginMethodsApi>;

/** 재인증으로 떠나기 전에 할 일을 남긴다 */
export function markPending(storage: StorageLike, p: Pending): void {
  storage.set(PENDING_KEY, JSON.stringify(p));
}

/** 돌아왔을 때 할 일이 10분 안이면 돌려준다. 늘 지운다(한 번만) */
export function takePending(storage: StorageLike, now: number): Pending | null {
  const v = storage.get(PENDING_KEY);
  storage.remove(PENDING_KEY);
  if (v === null) return null;
  try {
    const p = JSON.parse(v) as { action?: unknown; provider?: unknown; proposalId?: unknown; at?: unknown };
    if ((p.action !== 'unlink' && p.action !== 'add' && p.action !== 'merge') || !isProvider(p.provider) || typeof p.at !== 'number') return null;
    if (p.at > now || now - p.at > PENDING_TTL_MS) return null;
    if (p.action === 'merge') return isMergeProposalId(p.proposalId) ? { action: 'merge', provider: p.provider, proposalId: p.proposalId, at: p.at } : null;
    return { action: p.action, provider: p.provider, at: p.at };
  } catch {
    return null;
  }
}

/** 재인증 시작 양식(목적 비움 = FAN_SENSITIVE, identity §7.1 ①) */
export function reauthForm(provider: Provider): { action: string; fields: Record<string, string> } {
  return { action: `/reauth/${provider}`, fields: { returnTo: RETURN_TO, purpose: '' } };
}

/**
 * 재인증으로 떠난다: 액세스 토큰을 먼저 갱신하고(만료된 토큰이면 재인증 시작이 막다른 페이지가 된다), 할 일을 남긴 뒤 재인증 양식을 보낸다.
 * 갱신이 401이면 login(로그인 화면), 일시 장애면 retry(떠나지 않고 할 일도 남기지 않는다, 화면은 '잠시 뒤 다시', identity §2.1, 새 맥락 리뷰)
 */
export async function leaveForReauth(o: {
  api: { refresh(): Promise<RefreshResult> };
  storage: StorageLike;
  pending: Pending;
  provider: Provider;
  submit: (f: { action: string; fields: Record<string, string> }) => void;
}): Promise<'left' | 'login' | 'retry'> {
  const r = await o.api.refresh();
  if (r === 'rejected') return 'login';
  if (r !== 'ok') return 'retry';
  markPending(o.storage, o.pending);
  o.submit(reauthForm(o.provider));
  return 'left';
}

/** 로그인 수단 추가 시작 양식(POST /link/{p}, 재인증 토큰을 싣는다) */
export function linkForm(provider: Provider, token: string): { action: string; fields: Record<string, string> } {
  return { action: `/link/${provider}`, fields: { reauthToken: token, returnTo: RETURN_TO } };
}

/**
 * 추가 결과(?loginMethod=, 앱 서버가 붙인다)의 안내 문구. 모르는 값이면 null.
 * other-account에 병합 제안(?mergeProposal=)이 있으면 합치기 카드가 대신 말하므로 null, 없으면(세 서비스가 답하지 않음) 잠시 뒤 다시를 안내한다(BOT-043)
 */
export function addResultText(v: string | null, o: { merge?: boolean } = {}): { tone: 'success' | 'warning' | 'danger'; text: string } | null {
  switch (v) {
    case 'linked':
      return { tone: 'success', text: '로그인 수단을 연결했습니다' };
    case 'already-linked':
      return { tone: 'success', text: '이미 이 계정에 연결된 로그인 수단입니다' };
    case 'type-taken':
      return { tone: 'warning', text: '같은 종류의 로그인 수단이 이미 연결돼 있습니다. 먼저 해제한 뒤 다시 추가해 주세요' };
    case 'other-account':
      if (o.merge === true) return null;
      if (o.merge === false) return { tone: 'warning', text: '그 소셜 계정은 이미 다른 PEAKET 계정의 로그인 수단입니다. 지금은 두 계정을 합칠 수 없으니 잠시 뒤 다시 추가해 주세요' };
      return { tone: 'warning', text: '그 소셜 계정은 이미 다른 PEAKET 계정의 로그인 수단입니다' };
    case 'reauth-required':
      return { tone: 'danger', text: REAUTH_EXPIRED_RETRY };
    case 'failed':
      return { tone: 'danger', text: '지금은 처리할 수 없습니다. 잠시 뒤 다시 시도해 주세요' };
    default:
      return null;
  }
}

/** 해제 결과의 안내 문구 */
export function unlinkResultText(a: UnlinkAnswer): { tone: 'success' | 'warning' | 'danger'; text: string } {
  switch (a.kind) {
    case 'done':
      return { tone: 'success', text: '로그인 수단을 해제했습니다' };
    case 'last':
      return { tone: 'warning', text: '마지막 로그인 수단은 해제할 수 없습니다' };
    case 'missing':
      return { tone: 'warning', text: '이미 해제된 로그인 수단입니다' };
    case 'reauth':
      return { tone: 'danger', text: REAUTH_EXPIRED_RETRY };
    default:
      return { tone: 'danger', text: '지금은 처리할 수 없습니다. 잠시 뒤 다시 시도해 주세요' };
  }
}

/** ISO 시각을 화면 날짜(KST, 2026.09.01)로 */
export function dayText(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const k = new Date(d.getTime() + 9 * 3_600_000);
  return `${k.getUTCFullYear()}.${String(k.getUTCMonth() + 1).padStart(2, '0')}.${String(k.getUTCDate()).padStart(2, '0')}`;
}

const PROVIDER_LABEL: Record<Provider, string> = { kakao: '카카오', naver: '네이버', google: '구글' };

/** 사유 → 범주와 그 줄의 글(d5 §5.22 blocked) */
const BLOCKER_TEXT: Record<MergeBlocker, { category: MergeCategory; detail: string; banner: string }> = {
  ACTIVE_PURCHASE_SESSION: { category: 'ACTIVE_PURCHASE', detail: '해당 · 진행 중인 좌석 홀드나 구매가 있습니다', banner: '진행 중인 구매가 있어 합칠 수 없습니다. 구매를 마치거나 취소한 뒤 다시 추가해 주세요.' },
  PENDING_PAYMENT: { category: 'ACTIVE_PURCHASE', detail: '해당 · 결제를 기다리는 주문이 있습니다', banner: '결제를 기다리는 주문이 있어 합칠 수 없습니다. 결제를 마치거나 취소한 뒤 다시 추가해 주세요.' },
  QUOTA_EXCEEDED: { category: 'QUOTA_EXCEEDED', detail: '해당 · 두 계정의 보유 매수를 합치면 한도를 넘습니다', banner: '두 계정의 보유 매수를 합치면 한도를 넘어 합칠 수 없습니다. 보유 매수를 한도 안으로 줄인 뒤 다시 추가해 주세요.' },
  BOTH_VERIFIED: { category: 'BOTH_VERIFIED', detail: '해당 · 두 계정 모두 본인확인을 마쳤습니다', banner: '두 계정 모두 본인확인을 마쳐 합칠 수 없습니다. 고객센터로 문의해 주세요.' },
  WITHDRAWAL_IN_PROGRESS: { category: 'WITHDRAWAL_OR_APPEAL', detail: '해당 · 흡수될 계정의 탈퇴를 처리하고 있습니다', banner: '흡수될 계정의 탈퇴를 처리하고 있어 합칠 수 없습니다.' },
  APPEAL_PENDING: { category: 'WITHDRAWAL_OR_APPEAL', detail: '해당 · 흡수될 계정의 이의 제기를 처리하고 있습니다', banner: '흡수될 계정의 이의 제기를 처리하고 있어 합칠 수 없습니다. 처리가 끝난 뒤 다시 추가해 주세요.' },
  ENTRY_STARTED: { category: 'ENTRY_STARTED', detail: '해당 · 입장이 시작된 회차의 티켓이 있습니다', banner: '입장 중인 회차의 티켓이 있어 합칠 수 없습니다. 입장 기록이 마감된 뒤 다시 추가해 주세요.' },
};
const CATEGORY_ORDER: readonly MergeCategory[] = ['ACTIVE_PURCHASE', 'QUOTA_EXCEEDED', 'BOTH_VERIFIED', 'WITHDRAWAL_OR_APPEAL', 'ENTRY_STARTED'];

/** 합치기 카드(ds MergeSummary)에 넘길 글. titles는 다섯 범주의 줄 이름(entities/provider MERGE_CHECK_TITLES) */
export function mergeView(p: MergeProposalView, now: number, titles: Record<MergeCategory, string>) {
  const name = PROVIDER_LABEL[p.newProvider];
  const theirs = `${name}로 로그인하는 계정`;
  const verified = p.primaryVerified ? ' · 본인확인 완료' : '';
  const checks =
    p.status === 'BLOCKED' && p.blockers.length > 0
      ? CATEGORY_ORDER.map((c) => {
          const hit = p.blockers.filter((b) => BLOCKER_TEXT[b].category === c);
          return { title: titles[c], detail: hit.length ? hit.map((b) => BLOCKER_TEXT[b].detail).join(' / ') : '해당 없음', blocked: hit.length > 0 };
        })
      : [];
  const first = CATEGORY_ORDER.flatMap((c) => p.blockers.filter((b) => BLOCKER_TEXT[b].category === c))[0];
  return {
    question: `${name} 계정은 이미 다른 PEAKET 계정입니다. 두 계정을 합칠까요? 합치면 되돌릴 수 없습니다`,
    blockedQuestion: `${name} 계정은 이미 다른 PEAKET 계정입니다`,
    survivor: p.requesterRole === 'PRIMARY' ? `지금 계정${verified}` : `${theirs}${verified}`,
    absorbed: p.requesterRole === 'PRIMARY' ? theirs : '지금 계정',
    moves: [
      { label: '로그인 수단', value: `${p.moved.providers}개` },
      { label: '찜', value: `${p.moved.wishes}개` },
      { label: '알림 신청', value: `${p.moved.subscriptions}개` },
      { label: '배송지', value: `${p.moved.addresses}곳` },
    ],
    movesNote: p.moved.orders > 0 ? `흡수 계정의 주문 ${p.moved.orders}건은 원래 기록 그대로 두고 대표 계정의 '내 주문'에 함께 보입니다` : undefined,
    keeps: '닉네임 · 동의 내역',
    remaining: Math.max(0, Math.ceil((p.expiresAt - now) / 1000)),
    blockedReason: first ? BLOCKER_TEXT[first].banner : '지금은 두 계정을 합칠 수 없습니다. 고객센터로 문의해 주세요.',
    checks,
    merging: {
      message: '처리 중입니다. 완료되면 알림으로 안내해 드립니다',
      progressLabel: '계정 합치기 진행',
      steps: [
        { label: '흡수 계정 잠금·로그아웃', state: 'done' as const },
        { label: '로그인 수단·찜·알림·배송지 옮기는 중', state: 'active' as const },
        { label: '두 계정에 완료 알림', state: 'waiting' as const },
      ],
      note: '이 화면을 닫아도 처리는 계속됩니다.',
    },
    expiredText: '합치기 제안 시간이 지났습니다. 다시 추가해 주세요',
  };
}

/** 확정 결과의 안내 문구(accepted는 카드가 '처리 중'으로 바뀌어 안내한다) */
export function confirmMergeText(a: { kind: ConfirmMergeAnswer['kind'] }): { tone: 'success' | 'warning' | 'danger'; text: string } {
  switch (a.kind) {
    case 'accepted':
      return { tone: 'success', text: '두 계정을 합치기 시작했습니다' };
    case 'blocked':
      return { tone: 'warning', text: '그사이 합칠 수 없는 사유가 생겼습니다' };
    case 'invariant':
      return { tone: 'danger', text: '지금은 두 계정을 합칠 수 없습니다. 고객센터로 문의해 주세요' };
    case 'expired':
      return { tone: 'warning', text: '합치기 제안 시간이 지났습니다. 다시 추가해 주세요' };
    case 'reauth':
      return { tone: 'danger', text: REAUTH_EXPIRED_RETRY };
    case 'unavailable':
      return { tone: 'danger', text: '지금은 합칠 수 있는지 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요' };
    default:
      return { tone: 'danger', text: '지금은 처리할 수 없습니다. 잠시 뒤 다시 시도해 주세요' };
  }
}

type Tone = { tone: 'success' | 'warning' | 'danger'; text: string };

/**
 * 합치기 카드의 상태(LiveLoginMethods). token은 재인증 토큰(메모리에만, 확인 창을 연다), error는 확인 창 안의 안내.
 * dismissed는 닫았거나 불러오지 못해 치운 상태다
 */
export interface MergeState {
  id: string;
  view: MergeProposalView | null;
  phase: 'loading' | 'ready' | 'blocked' | 'expired' | 'merging' | 'dismissed';
  token?: { token: string; via: Provider };
  error?: string;
}
/** 다음 상태. login이면 로그인으로, go면 그 주소를 새 문서로 연다(mergedAway면 그 전에 흡수 표시를 남긴다), reload면 목록을 다시 읽는다 */
export type MergeStep = { merge?: MergeState; notice?: Tone; reload?: boolean; go?: string; mergedAway?: true; login?: boolean };

/** 지금 계정이 흡수된 뒤 여는 주소(로그인 전 셸로 흡수 안내, d5 §5.22 '지금 계정이 흡수됨') */
export const MERGED_AWAY_PATH = '/my/settings/providers?ended=MERGED';
/** 흡수 안내를 방금 흡수 확정을 받은 이 탭에만 보이게 남기는 표시(값은 남긴 시각, docs/frontend.md §3.12, BOT-043이 넘긴 것) */
export const MERGED_AWAY_KEY = 'peaket.providers.merged';
/** 표시를 믿는 시간 1분 [가정]: 떠나자마자 새 문서가 읽는다 */
export const MERGED_AWAY_TTL_MS = 60_000;

/** 흡수 안내로 떠나기 직전에 남긴다(로그아웃 정리 루틴은 그 앞에 돈다, frontend §5.14.4) */
export function markMergedAway(storage: StorageLike, now: number): void {
  storage.set(MERGED_AWAY_KEY, String(now));
}

/**
 * 흡수 안내 주소(?ended=MERGED)가 열릴 때: 1분 안의 표시가 있으면 true. 늘 지운다(한 번만).
 * 서버는 세션 종료 사유를 화면에 알려 주지 않아(갱신 401은 사유 없음) 주소만으로는 안내를 그리지 않는다(identity §2.1 '계정 병합의 첫 구현' 화면)
 */
export function takeMergedAway(storage: StorageLike, now: number): boolean {
  const v = storage.get(MERGED_AWAY_KEY);
  storage.remove(MERGED_AWAY_KEY);
  if (v === null || !/^\d+$/.test(v)) return false;
  const at = Number(v);
  return at <= now && now - at <= MERGED_AWAY_TTL_MS;
}

/**
 * 병합 제안을 읽은 뒤 주소창에서 지울 값(?mergeProposal=과 함께 온 ?loginMethod=). 지울 것이 없으면 null.
 * 카드를 닫은 뒤 새로 고쳐도 다시 뜨지 않고 그 방문 기록 항목에 남지 않게 한다(identity §2.1 '계정 병합의 첫 구현' 화면, BOT-043이 넘긴 것)
 */
export function mergeUrlWithoutProposal(pathname: string, search: string, hash: string): string | null {
  const q = new URLSearchParams(search);
  if (!q.has('mergeProposal') && !q.has('loginMethod')) return null;
  q.delete('mergeProposal');
  q.delete('loginMethod');
  const rest = q.toString();
  return `${pathname}${rest ? `?${rest}` : ''}${hash}`;
}

/** 제안을 읽은 뒤. 재인증 토큰은 PROPOSED일 때만 이어 받는다(그사이 막혔으면 확인 창을 열지 않는다) */
export function mergeAfterGet(id: string, r: MergeAnswer, token?: MergeState['token']): MergeStep {
  if (r.kind === 'login') return { login: true };
  if (r.kind === 'expired') return { merge: { id, view: null, phase: 'expired' } };
  if (r.kind === 'error') return { merge: { id, view: null, phase: 'dismissed' }, notice: { tone: 'danger', text: '합치기 제안을 불러오지 못했습니다. 잠시 뒤 다시 추가해 주세요' } };
  const blocked = r.proposal.status === 'BLOCKED';
  return { merge: { id, view: r.proposal, phase: blocked ? 'blocked' : 'ready', ...(token && !blocked ? { token } : {}) } };
}

/** 확정 결과 뒤. 503은 서버가 재인증 토큰을 쓰지 않았으므로 토큰과 확인 창을 두고 창 안에 안내한다 */
export function mergeAfterConfirm(m: MergeState, r: ConfirmMergeAnswer): MergeStep {
  const { token: _token, error: _error, ...base } = m;
  if (r.kind === 'login') return { login: true };
  if (r.kind === 'accepted') {
    // 지금 계정이 흡수되는 쪽이면 세션이 끝났다: 남은 화면 상태를 들고 가지 않게 새 문서로 흡수 안내를 연다
    if (m.view?.requesterRole === 'MERGED') return { go: MERGED_AWAY_PATH, mergedAway: true };
    return { merge: { ...base, phase: 'merging' }, reload: true };
  }
  if ((r.kind === 'blocked' || r.kind === 'invariant') && m.view) return { merge: { ...base, view: { ...m.view, status: 'BLOCKED', blockers: r.kind === 'blocked' ? r.blockers : [] }, phase: 'blocked' } };
  if (r.kind === 'expired') return { merge: { ...base, phase: 'expired' } };
  if (r.kind === 'unavailable') return { merge: { ...base, token: m.token, error: confirmMergeText(r).text } };
  // 재인증 만료·그 밖: 토큰을 버리고 목록 위에 안내(카드는 그대로라 다시 로그인하고 계속할 수 있다)
  return { merge: base, notice: confirmMergeText(r) };
}

/**
 * 화면을 열 때 읽을 병합 제안(LiveLoginMethods 첫 효과). 합치기 할 일이면 그 제안과 받은 재인증 토큰(받기에 실패했으면 토큰 없이),
 * 그 밖의 할 일(해제·추가)이나 할 일이 없으면 주소의 제안(?mergeProposal=)이다. 열 제안이 없으면 null
 */
export function mergeToOpen(p: Pending | null, urlId: string | undefined, t: ReauthAnswer | null): { id: string; token?: MergeState['token'] } | null {
  if (p?.action === 'merge') return { id: p.proposalId, ...(t?.kind === 'token' ? { token: { token: t.token, via: p.provider } } : {}) };
  return urlId ? { id: urlId } : null;
}
