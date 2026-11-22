// 화면 덩어리·원격 미리 받기(docs/frontend.md §5.7 '화면별 늦게 싣기', ADR-0091 결정 1, ADR-0361 결정 6).
// - 메뉴 항목에 포인터가 올라가거나 초점이 가면 그 화면의 경로 lazy를 미리 부른다(app/router.tsx가 경로 → lazy 표를 꽂는다)
// - 대시보드를 처음 그린 뒤 2초 [가정]가 지나면 명령 화면(SCR-030) 덩어리를 낮은 우선순위로 받고, 그다음 다음 단계 탭의 원격을
//   같은 무결성 적재기(낮은 우선순위)로 미리 싣는다. 적재기를 거치므로 위조 원격은 미리 싣기에서도 실행되지 않는다
//   (지금 원격 둘은 T=0·판매 중 탭의 위젯이라 두 원격을 함께 미리 싣는다)
import { loadRemoteWidgets, REMOTE_NAMES } from './remotes/load-remote';

/** 대시보드 첫 그림 뒤 명령 화면 미리 받기까지 2초 [가정] */
export const DASHBOARD_PRELOAD_DELAY_MS = 2_000;

const screens = new Map<string, () => Promise<unknown>>();
let commandsLow: (() => Promise<unknown>) | undefined;
let scheduled = false;
let fired = false;

/** 경로(앞 / 포함) → 그 화면 lazy. 명령 화면의 낮은 우선순위 받기를 함께 꽂는다 */
export function registerScreenPreloads(table: Readonly<Record<string, () => Promise<unknown>>>, commandsLowPriority: () => Promise<unknown>): void {
  for (const [path, load] of Object.entries(table)) screens.set(path, load);
  commandsLow = commandsLowPriority;
}

/** 그 경로 화면의 lazy를 미리 부른다(받지 못해도 화면 이동 때 다시 받는다) */
export function preloadScreen(href: string): void {
  let path: string;
  try {
    const u = new URL(href, 'http://console.local');
    if (u.origin !== 'http://console.local') return;
    path = u.pathname;
  } catch {
    return;
  }
  const load = screens.get(path);
  if (load) void load().catch(() => undefined);
}

/** 대시보드 첫 그림 뒤 한 번: 2초 뒤 명령 화면 덩어리(낮은 우선순위), 그다음 원격(live일 때만, 같은 적재기). 지우는 함수를 돌려준다 */
export function scheduleDashboardPreload(o: { live: boolean; delayMs?: number }): () => void {
  if (scheduled || fired) return () => undefined;
  scheduled = true;
  const t = globalThis.setTimeout(() => {
    fired = true;
    void (commandsLow?.() ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => {
        if (!o.live) return;
        for (const name of REMOTE_NAMES) void loadRemoteWidgets(name, { priority: 'low' }).catch(() => undefined);
      });
  }, o.delayMs ?? DASHBOARD_PRELOAD_DELAY_MS);
  // 2초 전에 대시보드를 떠나면 지우고, 돌아와 처음 그릴 때 다시 건다
  return () => {
    globalThis.clearTimeout(t);
    scheduled = false;
  };
}
