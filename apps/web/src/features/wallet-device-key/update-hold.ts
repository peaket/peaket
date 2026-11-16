// 월렛 워커 갱신 보류(docs/frontend.md §5.4 '갱신' ②③④, docs/design/d5 §3.1, BUILD_ORDER HOT-390).
// 회전 QR을 보이는 탭은 Web Lock을 쥐고, 다른 화면은 잠금이 비었을 때만 '새 버전이 있습니다'를 띄운다.
// - 잠금은 공유 모드·기다리지 않는 요청이다. 탭 여럿이 함께 쥐고, 하나가 놓아도 다른 탭이 쥐고 있으면 남는다(②).
// - [새로고침]은 잠금을 한 번 더 본 뒤 비었을 때만 waiting 워커에 SKIP_WAITING을 보낸다(③). Web Locks가 없으면 띄우지 않는다(④).

/** 회전 QR을 보이는 동안 쥐는 Web Lock 이름(docs/frontend.md §5.4 '갱신' ②) */
export const QR_LOCK_NAME: string = 'peaket.wallet.qr';

/** 월렛 워커 등록을 찾는 주소(범위 안의 주소, docs/frontend.md §5.4 '갱신' ③) */
export const WALLET_SCOPE_URL = '/my/tickets/';

/** 공유 잠금을 쥐고 놓는 함수를 돌려준다. `locks`가 없으면 아무것도 하지 않는 함수 */
export function holdQrLock(locks?: LockManager): () => void {
  if (!locks) return () => {};
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks
    .request(QR_LOCK_NAME, { mode: 'shared', ifAvailable: true }, async (lock) => {
      if (lock) await released;
    })
    .catch(() => {
      // 잠금을 못 쥐어도 QR은 그린다(갱신 보류만 약해진다)
    });
  return () => release();
}

/** 지금 어느 탭이든 QR 잠금을 쥐고 있는지. Web Locks가 없거나 물어보지 못하면 null */
export async function qrLockHeld(locks?: LockManager): Promise<boolean | null> {
  if (!locks) return null;
  try {
    const { held = [], pending = [] } = await locks.query();
    // 기다리지 않는 요청이라 pending은 거의 없지만, 막 쥐려는 탭도 쥔 것으로 본다
    return [...held, ...pending].some((l) => l.name === QR_LOCK_NAME);
  } catch {
    return null;
  }
}

/** 갱신을 미루는 화면: 대기실·좌석·결제·티켓(docs/design/d5-screen-blueprint.md §3.1). 앞의 로케일 접두(`/en`)는 떼고 본다 */
const HOLD_SCREENS = [
  /^\/queue(?:\/|$)/,
  /^\/shop\/[^/]+\/queue\/?$/,
  /^\/booking\/[^/]+\/(?:seats|checkout)(?:\/|$)/,
  /^\/shop\/checkout(?:\/|$)/,
  /^\/my\/tickets(?:\/|$)/,
];

/** 갱신을 미루는 화면인지: 대기실·좌석·결제·티켓 화면 */
export function isUpdateHoldScreen(pathname: string): boolean {
  const path = pathname.replace(/^\/en(?=\/|$)/, '') || '/';
  return HOLD_SCREENS.some((re) => re.test(path));
}

/** 토스트를 띄울지. `qrLockHeld === null`은 Web Locks가 없는 브라우저 */
export function shouldOfferUpdate(s: { hasWaiting: boolean; qrLockHeld: boolean | null; pathname: string }): boolean {
  return s.hasWaiting && s.qrLockHeld === false && !isUpdateHoldScreen(s.pathname);
}

/** [새로고침]: 잠금을 한 번 더 본 뒤 비었을 때만 waiting 워커에 `SKIP_WAITING`을 보낸다 */
export async function applyWaitingUpdate(d: { registration: Pick<ServiceWorkerRegistration, 'waiting'> | undefined; locks?: LockManager }): Promise<'sent' | 'held' | 'none'> {
  const waiting = d.registration?.waiting;
  if (!waiting) return 'none';
  // 잠금이 있거나(다른 탭이 그 사이 QR을 열었다) 확인하지 못하면 보내지 않는다
  if ((await qrLockHeld(d.locks)) !== false) return 'held';
  waiting.postMessage({ type: 'SKIP_WAITING' });
  return 'sent';
}
