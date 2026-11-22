// 로그아웃 정리 루틴이 지우는 브라우저 저장물 목록(docs/frontend.md §3.12 '지우는 때'에 '로그아웃'이 있는 값, §5.14.4 2·3번, ADR-0363 결정 8).
// 소비자 웹 루틴(./routine.ts)과 대기실 경량 페이지 루틴(apps/web/queue-room/src/live/logout.ts, 상대 경로로 가져온다)이 같은 목록을 쓴다.
// 남기는 것: 기기 식별값(peaket.device)·최근 검색어(peaket.recentSearches)·흡수 표시(peaket.providers.merged)·월렛 입장 키(3번을 고르지 않으면).
// 다른 모듈을 가져오지 않는다(두 빌드가 함께 읽는다).

/** localStorage: 접두로 지우는 것(회차 대기 정보·희망 조건) */
export const LOGOUT_LOCAL_PREFIXES: readonly string[] = ['peaket.queue.', 'peaket.autoassign.'];
/** localStorage: 이름으로 지우는 것(서버 시각 보정값·오프라인 찜 대기열) */
export const LOGOUT_LOCAL_KEYS: readonly string[] = ['peaket.clock', 'peaket.wishQueue'];
/** sessionStorage: 접두로 지우는 것(회차 대기·입장 토큰·결제 초안·홀드) */
export const LOGOUT_SESSION_PREFIXES: readonly string[] = ['peaket.queue.', 'peaket.admission.', 'peaket.checkout.', 'peaket.hold.'];
/**
 * sessionStorage: 이름으로 지우는 것(재인증 뒤 할 일 표시 넷·본인확인 복귀 건·스태프 초대·승인 조각).
 * `peaket.wallet.reauth`·`peaket.staff.fragment`는 2026-11-23(ADR-0363 결정 8, F-05-7)에 더했다
 */
export const LOGOUT_SESSION_KEYS: readonly string[] = [
  'peaket.withdraw.reauth',
  'peaket.providers.pending',
  'peaket.devices.reauth',
  'peaket.wallet.reauth',
  'peaket.verify.return',
  'peaket.staff.fragment',
];
/** IndexedDB: 지우는 DB(구매 세션 키·웹 푸시 '다시 등록 필요' 표시) */
export const LOGOUT_DATABASES: readonly string[] = ['peaket-purchase', 'peaket-push'];

/** 3번('이 기기의 입장 키도 지우기')에서만 지우는 월렛 DB */
export const WALLET_DATABASE = 'peaket-wallet';
/** 월렛 워커 등록 범위(끝 `/` 없음, ADR-0363 결정 5). 옛 등록(끝 `/`)도 같은 월렛 워커로 본다 */
export const WALLET_SCOPE_PATHS: readonly string[] = ['/my/tickets', '/my/tickets/'];
/** 웹 푸시 워커 범위. 정리 루틴은 이 등록을 풀지 않는다(§5.14.4 3번) */
export const PUSH_SCOPE_PATH = '/push/';

/** 3번에서 지우는 캐시인가: 월렛 런타임 캐시(`wallet-shell-{판}`)·판 없던 옛 이름 둘·월렛 워커 미리 저장·런타임 캐시(`serwist-`) */
export function isWalletCache(name: string): boolean {
  return name.startsWith('wallet-shell-') || name === 'wallet-pages' || name === 'wallet-assets' || name.startsWith('serwist-');
}

/** 월렛 워커 등록인가(범위 경로로 가른다) */
export function isWalletScope(scopeUrl: string): boolean {
  try {
    return WALLET_SCOPE_PATHS.includes(new URL(scopeUrl).pathname);
  } catch {
    return false;
  }
}

/** 다른 탭에 알리는 채널과 글(§5.14.4 4번) */
export const SESSION_CHANNEL = 'peaket.session';
export const LOGOUT_MESSAGE = 'logout';

/** 지울 키인가(local·session 각각의 접두·이름 목록) */
export function isLogoutKey(key: string, prefixes: readonly string[], keys: readonly string[]): boolean {
  return keys.includes(key) || prefixes.some((p) => key.startsWith(p));
}
