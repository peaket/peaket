// 입장용 휴대폰 등록 흐름: 키 만들기 → '확인 전'(LOCAL) 저장 → 서버 등록 → 결과대로 저장·삭제(FR-012, ADR-0336 결정 1~3, ADR-0363 결정 2·3).
// 규칙의 정본은 docs/frontend.md §4.2.4 '입장용 휴대폰 등록 세부', 화면 상태는 docs/design/d5 §5.13이다. 화면(ui/DeviceQr)은 이 파일의 함수만 부른다.
// - QR은 서버가 같은 keyId로 등록을 확인한 뒤('등록됨', REGISTERED)에만 허락한다(phase 'ready'). 팬 API 주소가 없는 빌드만 LOCAL 키로 허락한다(localOnly).
// - 다시 보내기는 저장된 같은 공개키로 한다. 새 키를 만들지 않는다. 오프라인(navigator.onLine === false)이면 보내지 않는다.
// - 거절(404·422·400·그 밖의 403)과 403 reissue-at-booth면 이 기기의 키를 지운다(부스 흐름은 그때 새 키를 만든다). '등록됨' 키는 이 흐름에서 지우거나 새로 만들지 않는다.
// - 403 reissue-required·reauth-required면 키를 두고 멈춘다(reauthNeeded). 화면을 다시 열어도 재인증 없이 다시 보내지 않는다.
//   재인증에서 돌아오면 sendWithReauth가 같은 공개키로 reason(REISSUE·ISSUE)과 X-Reauth-Token을 한 번 보낸다. 키가 없으면(저장소 유실) 그때 만들고 먼저 저장한다.
// - 응답을 기다리는 동안 저장된 키가 바뀌었으면(다른 탭·다시 만들기) 그 키를 덮거나 지우지 않는다(보낸 keyId와 같을 때만 고친다).
import { generateDeviceKey } from './device-key.ts';
import { deviceKeyRegistrationAvailable, registerDeviceKey, type DeviceKeyRegistrationResult, type DeviceKeyRetryReason, type RegisterDeviceKeyInput } from './register.ts';
import { deleteDeviceKey, loadDeviceKey, saveDeviceKey, walletDatabase, type StoredDeviceKey } from './store.ts';

/** 재인증 상태 위에 보일 까닭: expired(토큰 만료·재사용 403) · unavailable(503 reauth-unavailable) */
export type ReauthNotice = 'expired' | 'unavailable';

export type WalletKeyStatus =
  | { phase: 'no-key'; notice?: 'rejected' }
  /** QR을 보인다. localOnly는 팬 API 주소가 없는 빌드에서 이 기기에만 둔 키다('이 기기에만 등록됨') */
  | { phase: 'ready'; key: StoredDeviceKey; localOnly: boolean }
  /** '등록 확인 전': 키는 남아 있고 QR은 보이지 않는다. [다시 시도]·화면 다시 열기·online 사건에 같은 공개키로 다시 보낸다 */
  | { phase: 'pending'; key: StoredDeviceKey; reason: DeviceKeyRetryReason | 'offline' }
  /** '다시 확인 필요'(403 reauth-required, 입장 시작 뒤 첫 등록). 재인증으로 떠나 reason ISSUE로 다시 보낸다 */
  | { phase: 'needs-reauth'; key?: StoredDeviceKey; notice?: ReauthNotice }
  /** '저장소 유실, 입장 시작 전'(403 reissue-required). [ 다시 로그인하고 받기 ]로 떠나 reason REISSUE로 다시 보낸다 */
  | { phase: 'reissue-required'; key?: StoredDeviceKey; notice?: ReauthNotice }
  /** '저장소 유실, 입장 시작 뒤'(403 reissue-at-booth). 이 기기의 키는 지웠다. 부스 버튼은 GAT-190 전까지 없다 */
  | { phase: 'reissue-at-booth' }
  /** '재발급 한도'(재인증 뒤 교체의 429) */
  | { phase: 'reissue-limit'; key?: StoredDeviceKey }
  /** 토큰 갱신 뒤에도 401. 화면은 로그인으로 보내고 키는 둔다 */
  | { phase: 'needs-login'; key: StoredDeviceKey };

export interface SyncOptions {
  /** 화면이 오프라인으로 그리는 중(미리보기 offline 포함). 보내지 않고 '등록 확인 전'으로 둔다 */
  offline?: boolean;
  /** 첫 등록의 이유. 양도로 받은 표는 TRANSFER, 그 밖은 ISSUE(offline-gate §4, ADR-0051 결정 10) */
  firstReason?: 'ISSUE' | 'TRANSFER';
  /** 팬 API 출처·fetch(연결 시험). 없으면 ORIGINS.api·globalThis.fetch */
  origin?: string;
  fetch?: RegisterDeviceKeyInput['fetch'];
}

function browserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function registrationAvailable(o: SyncOptions): boolean {
  return o.origin !== undefined ? o.origin !== '' : deviceKeyRegistrationAvailable();
}

const transport = (o: SyncOptions): Pick<RegisterDeviceKeyInput, 'origin' | 'fetch'> => ({ ...(o.origin !== undefined ? { origin: o.origin } : {}), ...(o.fetch ? { fetch: o.fetch } : {}) });

/** 저장된 키가 지금도 보낸 그 키인가(티켓·keyId가 같다). 저장소를 못 쓰는 사생활 보호 모드면 메모리의 그 키로 본다 */
async function stillSame(key: StoredDeviceKey): Promise<StoredDeviceKey | undefined> {
  if (!walletDatabase()) return key;
  const current = await loadDeviceKey(key.ticketId);
  return current && current.keyId === key.keyId ? current : undefined;
}

/** 보낸 키가 그대로면 재인증 멈춤 표시를 적어 저장한다 */
async function markReauthNeeded(key: StoredDeviceKey, reauthNeeded: 'REISSUE' | 'ISSUE'): Promise<StoredDeviceKey> {
  const current = await stillSame(key);
  const next: StoredDeviceKey = { ...(current ?? key), reauthNeeded };
  if (current) await saveDeviceKey(next);
  return next;
}

/** 등록 결과대로 저장소를 고치고 상태를 정한다. sentReason은 이번에 보낸 reason이다 */
async function settle(key: StoredDeviceKey, result: DeviceKeyRegistrationResult, sentReason: RegisterDeviceKeyInput['reason']): Promise<WalletKeyStatus> {
  switch (result.kind) {
    case 'registered': {
      const current = await stillSame(key);
      if (!current) return statusOf(await loadDeviceKey(key.ticketId));
      const registered: StoredDeviceKey = { ...current, registration: 'REGISTERED', reason: sentReason };
      delete registered.reauthNeeded;
      await saveDeviceKey(registered);
      return { phase: 'ready', key: registered, localOnly: false };
    }
    case 'unavailable':
      return { phase: 'ready', key, localOnly: true };
    case 'retry':
      return { phase: 'pending', key, reason: result.reason };
    case 'needs-reauth': {
      const kept = await markReauthNeeded(key, 'ISSUE');
      return { phase: 'needs-reauth', key: kept, ...(result.withToken ? { notice: 'expired' as const } : {}) };
    }
    case 'reissue-required': {
      const kept = await markReauthNeeded(key, 'REISSUE');
      return { phase: 'reissue-required', key: kept, ...(result.withToken ? { notice: 'expired' as const } : {}) };
    }
    case 'reauth-unavailable': {
      const want = key.reauthNeeded ?? (sentReason === 'ISSUE' ? 'ISSUE' : 'REISSUE');
      const kept = await markReauthNeeded(key, want);
      return want === 'ISSUE' ? { phase: 'needs-reauth', key: kept, notice: 'unavailable' } : { phase: 'reissue-required', key: kept, notice: 'unavailable' };
    }
    case 'reissue-at-booth': {
      // '그 밖의 403'처럼 지운다(ADR-0363 결정 3). 부스 흐름은 그때 새 키를 만든다
      if (await stillSame(key)) await deleteDeviceKey(key.ticketId);
      return { phase: 'reissue-at-booth' };
    }
    case 'reissue-limit':
      return { phase: 'reissue-limit', key };
    case 'needs-login':
      return { phase: 'needs-login', key };
    case 'rejected': {
      if (await stillSame(key)) await deleteDeviceKey(key.ticketId);
      return { phase: 'no-key', notice: 'rejected' };
    }
  }
}

/** LOCAL 키를 서버에 한 번 보내고 결과대로 저장소를 고친다 */
async function sendRegistration(key: StoredDeviceKey, o: SyncOptions): Promise<WalletKeyStatus> {
  if (!registrationAvailable(o)) return { phase: 'ready', key, localOnly: true };
  if (o.offline || browserOffline()) return { phase: 'pending', key, reason: 'offline' };
  const result = await registerDeviceKey({ ticketId: key.ticketId, publicKeyJwk: key.publicKeyJwk, keyId: key.keyId, reason: key.reason, ...transport(o) });
  return settle(key, result, key.reason);
}

/** 저장된 키만 보고 정하는 상태(보내지 않는다) */
function statusOf(key: StoredDeviceKey | undefined, o: SyncOptions = {}): WalletKeyStatus {
  if (!key) return { phase: 'no-key' };
  if (key.registration === 'REGISTERED') return { phase: 'ready', key, localOnly: false };
  if (!registrationAvailable(o)) return { phase: 'ready', key, localOnly: true };
  if (key.reauthNeeded === 'REISSUE') return { phase: 'reissue-required', key };
  if (key.reauthNeeded === 'ISSUE') return { phase: 'needs-reauth', key };
  return { phase: 'pending', key, reason: 'offline' };
}

/** 같은 티켓의 동기화가 겹치면(부품이 붙을 때와 online 사건) 하나로 묶는다 */
const inFlight = new Map<string, Promise<WalletKeyStatus>>();

function once(ticketId: string, run: () => Promise<WalletKeyStatus>): Promise<WalletKeyStatus> {
  const running = inFlight.get(ticketId);
  if (running) return running;
  const p = run().finally(() => inFlight.delete(ticketId));
  inFlight.set(ticketId, p);
  return p;
}

/**
 * 저장된 키를 읽어 필요하면 같은 공개키로 서버에 다시 보낸다(부품이 붙을 때·[다시 시도]·online 사건).
 * 등록됨 키와 재인증을 기다리는 키(reauthNeeded)는 보내지 않는다. 키가 없으면 no-key다
 */
export function syncDeviceKeyRegistration(ticketId: string, o: SyncOptions = {}): Promise<WalletKeyStatus> {
  return once(ticketId, async () => {
    const key = await loadDeviceKey(ticketId);
    if (!key || key.registration === 'REGISTERED' || key.reauthNeeded) return statusOf(key, o);
    return sendRegistration(key, o);
  });
}

async function newLocalKey(ticketId: string, reason: StoredDeviceKey['reason']): Promise<StoredDeviceKey> {
  const generated = await generateDeviceKey();
  const key: StoredDeviceKey = {
    ticketId,
    keyId: generated.keyIdText,
    privateKey: generated.privateKey,
    publicKeyJwk: generated.publicKeyJwk,
    createdAt: Date.now(),
    reason,
    registration: 'LOCAL',
  };
  await saveDeviceKey(key);
  return key;
}

/**
 * '이 휴대폰을 입장용으로 등록': 키를 만들어 '확인 전'(LOCAL)으로 먼저 저장하고 ISSUE로 보낸다.
 * 이미 이 티켓의 키가 있으면 새로 만들지 않고 그 키로 동기화한다(등록됨 키는 그대로)
 */
export async function enrollDeviceKey(ticketId: string, o: SyncOptions = {}): Promise<WalletKeyStatus> {
  const existing = await loadDeviceKey(ticketId);
  if (existing) return syncDeviceKeyRegistration(ticketId, o);
  const key = await newLocalKey(ticketId, o.firstReason ?? 'ISSUE');
  return sendRegistration(key, o);
}

export interface SendWithReauthInput extends SyncOptions {
  ticketId: string;
  /** 재인증으로 떠날 때 남긴 reason(REISSUE: 저장소 유실 입장 시작 전, ISSUE: 입장 시작 뒤 첫 등록) */
  reason: 'REISSUE' | 'ISSUE';
  /** POST /reauth/token으로 받은 토큰(메모리에만, 한 번) */
  reauthToken: string;
}

/**
 * 재인증에서 돌아와 한 번 보낸다(ADR-0363 결정 3): 이 기기의 키(같은 공개키)로 reason과 X-Reauth-Token을 보낸다.
 * 키가 없으면(저장소 유실) 그때 새로 만들고 '확인 전'으로 먼저 저장한 뒤 보낸다. 등록됨 키면 보내지 않는다
 */
export function sendWithReauth(i: SendWithReauthInput): Promise<WalletKeyStatus> {
  return once(i.ticketId, async () => {
    const existing = await loadDeviceKey(i.ticketId);
    if (existing?.registration === 'REGISTERED') return { phase: 'ready', key: existing, localOnly: false };
    const key = existing ?? (await newLocalKey(i.ticketId, i.reason));
    if (!registrationAvailable(i)) return { phase: 'ready', key, localOnly: true };
    if (i.offline || browserOffline()) return { phase: 'pending', key, reason: 'offline' };
    const result = await registerDeviceKey({ ticketId: key.ticketId, publicKeyJwk: key.publicKeyJwk, keyId: key.keyId, reason: i.reason, reauthToken: i.reauthToken, ...transport(i) });
    return settle({ ...key, reauthNeeded: i.reason }, result, i.reason);
  });
}

/**
 * 재인증을 못 받고 돌아왔을 때(표시가 낡음·재인증 실패·취소): 요청 없이 저장된 키의 멈춘 상태로 돌아간다.
 * 이 기기에 키가 없으면(저장소 유실) 떠날 때의 reason으로 '저장소 유실, 입장 시작 전'·'다시 확인 필요'를 보인다
 */
export async function walletKeyStatusWithoutSending(ticketId: string, o: SyncOptions & { reason?: 'REISSUE' | 'ISSUE'; notice?: ReauthNotice } = {}): Promise<WalletKeyStatus> {
  const key = await loadDeviceKey(ticketId);
  const notice = o.notice ? { notice: o.notice } : {};
  if (!key && o.reason) return o.reason === 'REISSUE' ? { phase: 'reissue-required', ...notice } : { phase: 'needs-reauth', ...notice };
  const st = statusOf(key, o);
  if ((st.phase === 'reissue-required' || st.phase === 'needs-reauth') && o.notice) return { ...st, notice: o.notice };
  return st;
}
