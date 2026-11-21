// 입장용 휴대폰 등록 흐름: 키 만들기 → '확인 전'(LOCAL) 저장 → 서버 등록 → 결과대로 저장·삭제(FR-012, ADR-0336 결정 1~3).
// 규칙의 정본은 docs/frontend.md §4.2.4 '입장용 휴대폰 등록 세부', 화면 상태는 docs/design/d5 §5.13이다. 화면(ui/DeviceQr)은 이 두 함수만 부른다.
// - QR은 서버가 같은 keyId로 등록을 확인한 뒤('등록됨', REGISTERED)에만 허락한다(phase 'ready'). 팬 API 주소가 없는 빌드만 LOCAL 키로 허락한다(localOnly).
// - 다시 보내기는 저장된 같은 공개키로 한다. 새 키를 만들지 않는다. 오프라인(navigator.onLine === false)이면 보내지 않는다.
// - 거절(404·422·400·그 밖의 403)이면 이 기기의 키를 지운다. '등록됨' 키는 이 흐름에서 지우거나 새로 만들지 않는다.
// - 응답을 기다리는 동안 저장된 키가 바뀌었으면(다른 탭·다시 만들기) 그 키를 덮거나 지우지 않는다(보낸 keyId와 같을 때만 고친다).
import { generateDeviceKey } from './device-key.ts';
import { deviceKeyRegistrationAvailable, registerDeviceKey, type DeviceKeyRetryReason } from './register.ts';
import { deleteDeviceKey, loadDeviceKey, saveDeviceKey, walletDatabase, type StoredDeviceKey } from './store.ts';

export type WalletKeyStatus =
  | { phase: 'no-key'; notice?: 'rejected' }
  /** QR을 보인다. localOnly는 팬 API 주소가 없는 빌드에서 이 기기에만 둔 키다('이 기기에만 등록됨') */
  | { phase: 'ready'; key: StoredDeviceKey; localOnly: boolean }
  /** '등록 확인 전': 키는 남아 있고 QR은 보이지 않는다. [다시 시도]·화면 다시 열기·online 사건에 같은 공개키로 다시 보낸다 */
  | { phase: 'pending'; key: StoredDeviceKey; reason: DeviceKeyRetryReason | 'offline' }
  /** '다시 확인 필요'(403 reauth-required). 재인증 시트로 잇는 것은 GAT-020 몫이다 */
  | { phase: 'needs-reauth'; key: StoredDeviceKey }
  /** 토큰 갱신 뒤에도 401. 화면은 로그인으로 보내고 키는 둔다 */
  | { phase: 'needs-login'; key: StoredDeviceKey };

export interface SyncOptions {
  /** 화면이 오프라인으로 그리는 중(미리보기 offline 포함). 보내지 않고 '등록 확인 전'으로 둔다 */
  offline?: boolean;
}

function browserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** 저장된 키가 지금도 보낸 그 키인가(티켓·keyId가 같다). 저장소를 못 쓰는 사생활 보호 모드면 메모리의 그 키로 본다 */
async function stillSame(key: StoredDeviceKey): Promise<StoredDeviceKey | undefined> {
  if (!walletDatabase()) return key;
  const current = await loadDeviceKey(key.ticketId);
  return current && current.keyId === key.keyId ? current : undefined;
}

/** LOCAL 키를 서버에 한 번 보내고 결과대로 저장소를 고친다 */
async function sendRegistration(key: StoredDeviceKey, o: SyncOptions): Promise<WalletKeyStatus> {
  if (!deviceKeyRegistrationAvailable()) return { phase: 'ready', key, localOnly: true };
  if (o.offline || browserOffline()) return { phase: 'pending', key, reason: 'offline' };
  const result = await registerDeviceKey({ ticketId: key.ticketId, publicKeyJwk: key.publicKeyJwk, keyId: key.keyId, reason: key.reason });
  switch (result.kind) {
    case 'registered': {
      const current = await stillSame(key);
      if (!current) return statusOf(await loadDeviceKey(key.ticketId));
      const registered: StoredDeviceKey = { ...current, registration: 'REGISTERED' };
      await saveDeviceKey(registered);
      return { phase: 'ready', key: registered, localOnly: false };
    }
    case 'unavailable':
      return { phase: 'ready', key, localOnly: true };
    case 'retry':
      return { phase: 'pending', key, reason: result.reason };
    case 'needs-reauth':
      return { phase: 'needs-reauth', key };
    case 'needs-login':
      return { phase: 'needs-login', key };
    case 'rejected': {
      if (await stillSame(key)) await deleteDeviceKey(key.ticketId);
      return { phase: 'no-key', notice: 'rejected' };
    }
  }
}

/** 저장된 키만 보고 정하는 상태(보내지 않는다) */
function statusOf(key: StoredDeviceKey | undefined): WalletKeyStatus {
  if (!key) return { phase: 'no-key' };
  if (key.registration === 'REGISTERED') return { phase: 'ready', key, localOnly: false };
  if (!deviceKeyRegistrationAvailable()) return { phase: 'ready', key, localOnly: true };
  return { phase: 'pending', key, reason: 'offline' };
}

/** 같은 티켓의 동기화가 겹치면(부품이 붙을 때와 online 사건) 하나로 묶는다 */
const inFlight = new Map<string, Promise<WalletKeyStatus>>();

/**
 * 저장된 키를 읽어 필요하면 같은 공개키로 서버에 다시 보낸다(부품이 붙을 때·[다시 시도]·online 사건).
 * 등록됨 키는 부르지 않는다. 키가 없으면 no-key다
 */
export function syncDeviceKeyRegistration(ticketId: string, o: SyncOptions = {}): Promise<WalletKeyStatus> {
  const running = inFlight.get(ticketId);
  if (running) return running;
  const run = (async () => {
    const key = await loadDeviceKey(ticketId);
    if (!key || key.registration === 'REGISTERED') return statusOf(key);
    return sendRegistration(key, o);
  })().finally(() => inFlight.delete(ticketId));
  inFlight.set(ticketId, run);
  return run;
}

/**
 * '이 휴대폰을 입장용으로 등록': 키를 만들어 '확인 전'(LOCAL)으로 먼저 저장하고 ISSUE로 보낸다.
 * 이미 이 티켓의 키가 있으면 새로 만들지 않고 그 키로 동기화한다(등록됨 키는 그대로)
 */
export async function enrollDeviceKey(ticketId: string, o: SyncOptions = {}): Promise<WalletKeyStatus> {
  const existing = await loadDeviceKey(ticketId);
  if (existing) return syncDeviceKeyRegistration(ticketId, o);
  const generated = await generateDeviceKey();
  const key: StoredDeviceKey = {
    ticketId,
    keyId: generated.keyIdText,
    privateKey: generated.privateKey,
    publicKeyJwk: generated.publicKeyJwk,
    createdAt: Date.now(),
    reason: 'ISSUE',
    registration: 'LOCAL',
  };
  await saveDeviceKey(key);
  return sendRegistration(key, o);
}
