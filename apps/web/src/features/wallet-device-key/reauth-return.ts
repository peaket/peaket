// 월렛 재발급·입장 시작 뒤 첫 등록의 재인증 왕복(ADR-0363 결정 3, docs/frontend.md §3.12 `peaket.wallet.reauth`, d5 §5.13, O-T49).
// - 떠날 때: 탭 저장소 `peaket.wallet.reauth`에 `{v, ticketId, reason, at}`만 남긴다(토큰·공개키는 넣지 않는다). 그다음 웹 purpose `device-key-issue`로
//   재인증 양식을 이 창에서 보낸다(돌아올 곳은 그 티켓 펼침 `/my/tickets/{ticketId}`).
// - 돌아왔을 때: 표시를 한 번 읽고 늘 지운다. 남긴 지 10분 [가정] 안이고 같은 티켓일 때만 믿는다. 믿으면 `POST /reauth/token`으로 토큰을 메모리에 받아
//   enrollment.sendWithReauth로 같은 공개키를 한 번 보낸다. 낡았거나 재인증이 실패·취소되면 요청 없이 멈춘 상태(①)로 돌아간다.
// - 새로고침하면 표시가 없으므로 다시 보내지 않는다(O-T49 ⑦). 로그아웃 정리 루틴도 이 표시를 지운다(§5.14.4 2번).
// 바깥 의존(탭 저장소·시계·토큰 받기·양식 보내기·제공자 찾기)은 주입한다(시험·연결 시험이 같은 모양으로 부른다).
import { pickupReauthToken, submitReauthForm } from '../../shared/lib/reauth-return.ts';
import type { ReauthFailure } from '../../shared/lib/reauth-failure.ts';
import { sendWithReauth, walletKeyStatusWithoutSending, type SyncOptions, type WalletKeyStatus } from './enrollment.ts';

export const WALLET_REAUTH_KEY = 'peaket.wallet.reauth';
/** 표시를 믿는 시간 10분 [가정](§3.12) */
export const WALLET_REAUTH_TTL_MS = 10 * 60_000;
/** 기기 키 등록의 재인증 웹 purpose(앱 서버가 DEVICE_KEY_ISSUE로 바꾼다, features/social-login/server/identity-client.ts) */
export const WALLET_REAUTH_PURPOSE = 'device-key-issue';

export type WalletReauthReason = 'REISSUE' | 'ISSUE';

export interface WalletReauthMarker {
  v: 1;
  ticketId: string;
  reason: WalletReauthReason;
  at: number;
}

export interface TabStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 표시를 남긴다(토큰·공개키 없음) */
export function writeWalletReauth(store: TabStorageLike, m: { ticketId: string; reason: WalletReauthReason; at: number }): void {
  const marker: WalletReauthMarker = { v: 1, ticketId: m.ticketId, reason: m.reason, at: m.at };
  store.setItem(WALLET_REAUTH_KEY, JSON.stringify(marker));
}

export type WalletReauthTake = { kind: 'none' } | { kind: 'stale'; ticketId?: string; reason?: WalletReauthReason } | { kind: 'fresh'; marker: WalletReauthMarker };

/**
 * 표시를 한 번 읽고 늘 지운다. 남긴 지 10분(정각까지는 믿는다) 안이고 모양이 맞으면 fresh, 지났거나 앞날이거나 모양이 틀리면 stale, 없으면 none
 */
export function takeWalletReauth(store: TabStorageLike, nowMs: number): WalletReauthTake {
  let raw: string | null;
  try {
    raw = store.getItem(WALLET_REAUTH_KEY);
  } catch {
    return { kind: 'none' };
  }
  if (raw === null) return { kind: 'none' };
  try {
    store.removeItem(WALLET_REAUTH_KEY);
  } catch {
    // 지우지 못해도 아래 판정은 한다
  }
  let m: Partial<WalletReauthMarker>;
  try {
    m = JSON.parse(raw) as Partial<WalletReauthMarker>;
  } catch {
    return { kind: 'stale' };
  }
  const reason = m.reason === 'REISSUE' || m.reason === 'ISSUE' ? m.reason : undefined;
  const ticketId = typeof m.ticketId === 'string' && m.ticketId !== '' ? m.ticketId : undefined;
  const at = typeof m.at === 'number' && Number.isFinite(m.at) ? m.at : undefined;
  if (m.v !== 1 || !reason || !ticketId || at === undefined) return { kind: 'stale', ...(ticketId ? { ticketId } : {}), ...(reason ? { reason } : {}) };
  const age = nowMs - at;
  if (age < 0 || age > WALLET_REAUTH_TTL_MS) return { kind: 'stale', ticketId, reason };
  return { kind: 'fresh', marker: { v: 1, ticketId, reason, at } };
}

export interface LeaveForWalletReauthDeps {
  store: TabStorageLike;
  now: () => number;
  /** 재인증할 소셜 제공자(지금 계정에 연결된 것 하나) */
  provider: string;
  /** 재인증 양식 보내기(기본 shared/lib/reauth-return submitReauthForm) */
  submit?: (provider: string, returnTo: string, purpose: string) => void;
}

/** [ 다시 로그인하고 받기 ]·'다시 확인 필요'의 재인증: 표시를 남기고 이 창에서 재인증으로 떠난다 */
export function leaveForWalletReauth(i: { ticketId: string; reason: WalletReauthReason }, d: LeaveForWalletReauthDeps): void {
  writeWalletReauth(d.store, { ticketId: i.ticketId, reason: i.reason, at: d.now() });
  (d.submit ?? submitReauthForm)(d.provider, `/my/tickets/${encodeURIComponent(i.ticketId)}`, WALLET_REAUTH_PURPOSE);
}

export type WalletReauthResume =
  /** 표시가 없거나 다른 티켓의 것이다(아무것도 보내지 않았다) */
  | { kind: 'none' }
  /** 표시가 낡았다(10분 지남). 요청 없이 멈춘 상태로 돌아간다 */
  | { kind: 'stale'; status: WalletKeyStatus }
  /** 재인증이 실패·취소됐다. 요청 없이 멈춘 상태로 돌아가고 d5 §3의 실패 문구를 보인다 */
  | { kind: 'reauth-failed'; reason: ReauthFailure; status: WalletKeyStatus }
  /** 토큰으로 한 번 보냈다 */
  | { kind: 'sent'; reason: WalletReauthReason; status: WalletKeyStatus };

export interface ResumeWalletReauthDeps extends SyncOptions {
  store: TabStorageLike;
  now: () => number;
  /** POST /reauth/token(기본 shared/lib/reauth-return pickupReauthToken, 같은 출처 앱 서버) */
  pickup?: () => ReturnType<typeof pickupReauthToken>;
}

/** 티켓 펼침이 붙을 때 한 번 부른다: 이 티켓의 표시가 있으면 읽고 지운 뒤 토큰을 받아 한 번 보낸다 */
export async function resumeWalletReauth(ticketId: string, d: ResumeWalletReauthDeps): Promise<WalletReauthResume> {
  const taken = takeWalletReauth(d.store, d.now());
  const transport: SyncOptions = { ...(d.offline !== undefined ? { offline: d.offline } : {}), ...(d.origin !== undefined ? { origin: d.origin } : {}), ...(d.fetch ? { fetch: d.fetch } : {}) };
  if (taken.kind === 'none') return { kind: 'none' };
  if (taken.kind === 'stale') {
    if (taken.ticketId !== undefined && taken.ticketId !== ticketId) return { kind: 'none' };
    return { kind: 'stale', status: await walletKeyStatusWithoutSending(ticketId, { ...transport, ...(taken.reason ? { reason: taken.reason } : {}) }) };
  }
  if (taken.marker.ticketId !== ticketId) return { kind: 'none' };
  const reason = taken.marker.reason;
  const r = await (d.pickup ?? (() => pickupReauthToken()))();
  if (r.kind !== 'token') return { kind: 'reauth-failed', reason: r.reason, status: await walletKeyStatusWithoutSending(ticketId, { ...transport, reason }) };
  return { kind: 'sent', reason, status: await sendWithReauth({ ...transport, ticketId, reason, reauthToken: r.token }) };
}
