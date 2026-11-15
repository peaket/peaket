// 월렛 워커 갱신 보류(docs/frontend.md §5.4 '갱신' ②③④, docs/design/d5 §3.1, BUILD_ORDER HOT-390).
// 회전 QR을 보이는 탭은 Web Lock을 쥐고, 다른 화면은 잠금이 비었을 때만 '새 버전이 있습니다'를 띄운다.
// 시험 담당이 먼저 둔 빈 뼈대다(BAT-170 웨이브 7, ADR-0270 결정 3). 동작과 잠금 이름 값은 구현 담당이 쓴다.

/** 회전 QR을 보이는 동안 쥐는 Web Lock 이름(정본 값은 docs/frontend.md §5.4 '갱신' ②) */
export const QR_LOCK_NAME: string = '아직 없음';

/** 공유 잠금을 쥐고 놓는 함수를 돌려준다. `locks`가 없으면 아무것도 하지 않는 함수 */
export function holdQrLock(locks?: LockManager): () => void {
  void locks;
  throw new Error('아직 없음');
}

/** 갱신을 미루는 화면인지: 대기실·좌석·결제·티켓 화면 */
export function isUpdateHoldScreen(pathname: string): boolean {
  void pathname;
  throw new Error('아직 없음');
}

/** 토스트를 띄울지. `qrLockHeld === null`은 Web Locks가 없는 브라우저 */
export function shouldOfferUpdate(s: { hasWaiting: boolean; qrLockHeld: boolean | null; pathname: string }): boolean {
  void s;
  throw new Error('아직 없음');
}

/** [새로고침]: 잠금을 한 번 더 본 뒤 비었을 때만 waiting 워커에 `SKIP_WAITING`을 보낸다 */
export async function applyWaitingUpdate(d: { registration: Pick<ServiceWorkerRegistration, 'waiting'> | undefined; locks?: LockManager }): Promise<'sent' | 'held' | 'none'> {
  void d;
  throw new Error('아직 없음');
}
