// 팬 토큰 갱신을 창끼리 하나씩 돌리는 잠금(Web Locks, docs/features/identity.md §5 '부르는 화면'·§3).
// 같은 리프레시 토큰으로 두 창이 동시에 갱신하면 늦게 받은 쪽 쿠키가 폐기된 토큰이 되어, 다음 갱신이 재사용 탐지에 걸려 세션이 끝날 수 있다.
// 본인확인·탈퇴·로그인 수단 흐름과 팬 API 클라이언트가 이 하나를 쓴다(같은 이름이어야 서로 막는다, BOT-010이 넘긴 것). 경로 별칭이 없어 node 시험이 바로 읽는다.

export const REFRESH_LOCK = 'peaket.refresh';

/** LockManager.request의 쓰는 모양만 */
export interface LockManagerLike {
  request<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

function navigatorLocks(): LockManagerLike | null {
  return typeof navigator === 'undefined' || !navigator.locks ? null : (navigator.locks as unknown as LockManagerLike);
}

/** fn을 `peaket.refresh` 배타 잠금 안에서 부른다. Web Locks가 없는 브라우저(null)는 그대로 부른다 */
export function refreshLock<T>(fn: () => Promise<T>, locks: LockManagerLike | null = navigatorLocks()): Promise<T> {
  return locks ? locks.request(REFRESH_LOCK, fn) : fn();
}
