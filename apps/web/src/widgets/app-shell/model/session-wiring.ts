// 셸의 세션 배선(ADR-0363 결정 7·8, docs/frontend.md §4.2.4·§5.14.4). AppShell이 import()로 늦게 싣는다(첫 JS에 넣지 않는다).
// - logout: 대화상자의 [로그아웃]. 웹 푸시 해제 DELETE → 저장물 → (골랐으면) 월렛 → 다른 탭에 logout → 같은 출처 fetch POST /logout.
//   이동이나 2xx면 홈으로, 503·연결 실패면 대화상자 안에 다시 시도를 안내한다.
// - start: 다른 탭의 logout을 받으면 저장물을 지우고 로그인 화면으로 간다. 로그인한 셸이면 웹 푸시 구독을 지금 계정에 다시 묶는다
//   (권한을 묻지 않는다). 다시 묶기는 문서마다 한 번, 실패하면 다음에 한 번 더. 돌려준 함수로 듣기를 멈춘다.
// - enable: CMP-068 [알림 켜기]의 웹 푸시 켜기.
// 이름은 짧게 둔다(셸 첫 JS에 이 모듈의 내보내기 이름이 남는다).
import { listenSessionLogout, logoutCleanup } from '@/features/session-cleanup';
import { browserWebPush, PUSH_EMAIL_FALLBACK_TEXT } from '@/features/web-push';

const LOGOUT_FAILED = '로그아웃하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요';

export async function logout({ clearEntryKeys }: { clearEntryKeys: boolean }): Promise<{ error?: string } | void> {
  const r = await logoutCleanup({ wallet: clearEntryKeys, server: true, pushUnbind: () => browserWebPush().unbind() });
  if (r.server === 'ok') {
    window.location.assign('/');
    return;
  }
  return { error: LOGOUT_FAILED };
}


/**
 * CMP-068 [알림 켜기]: 권한을 묻고 /push/sw.js로 구독해 등록한다(ADR-0363 결정 7). 켤 수 없으면(권한 거부·미지원·VAPID 공개키 없음·422)
 * toast로 "이메일로 알려 드립니다"를 띄운다. 켜졌으면 true
 */
export async function enable(toast?: (message: string, icon?: string) => void): Promise<boolean> {
  const r = await browserWebPush()
    .enable()
    .catch(() => ({ kind: 'email-only' as const }));
  if (r.kind !== 'subscribed') toast?.(PUSH_EMAIL_FALLBACK_TEXT, 'ic-mail');
  return r.kind === 'subscribed';
}

let rebound = false;

export function start(signedIn: boolean): () => void {
  const stop = listenSessionLogout(() => window.location.assign('/login'));
  if (signedIn) rebindPushOnce();
  return stop;
}

function rebindPushOnce(): void {
  if (rebound) return;
  rebound = true;
  void browserWebPush()
    .rebind()
    .then((r) => {
      if (r.kind === 'failed') rebound = false;
    })
    .catch(() => {
      rebound = false;
    });
}
