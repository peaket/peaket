// 대기실 경량 페이지 진입점(docs/frontend.md §5.1). React 없이 상태표(§3.4) + DOM 갱신으로 그린다.
// 대기열·매진(SCR-008·018)은 데이터에 이었다(ADR-0207): 상태 기계(src/live/controller.ts)가 실제 응답으로 화면 값을 낸다.
// 로비(SCR-007)와 굿즈 대기(SCR-015)는 아직 퍼블리싱이라 목업(fixtures)과 `?state=`로 그린다(HOT-341, 굿즈 단계). 다크는 `?theme=dark`.
import '@peaket/ds/queue-room.css';
import './styles/app.css';
import { links } from './config';
import type { BaseCtx, Ctx, LiveCtx, ModalKey } from './ctx';
import { cx } from './dom';
import { findEvent, findProduct } from './fixtures';
import { browserEnv } from './live/browser';
import { startQueue, type Controller, type QueueView } from './live/controller.ts';
import { emptyMeta, metaFromSummary, type EventMeta } from './live/meta.ts';
import { createNet } from './live/net.ts';
import { ORIGINS } from './config';
import { parseRoute } from './route';
import { goodsQueueScreen } from './screens/goods';
import { lobbyScreen } from './screens/lobby';
import { modalBuild, type ModalDeps } from './screens/modals';
import { queueScreen, updateQueueNumbers } from './screens/queue';
import { liveSoldOutScreen } from './screens/soldout';
import { findState, GOODS_STATES, LOBBY_STATES, stateHref, type BoardState } from './states';
import { closeModal, openModal } from './ui/modal';

const root = document.getElementById('root')!;
let cleanups: (() => void)[] = [];
const q = new URLSearchParams(location.search);
const dark = q.get('theme') === 'dark';
const route = parseRoute(location.pathname);

function clear(): void {
  for (const f of cleanups) f();
  cleanups = [];
  closeModal(false);
}

function baseCtx(deps: () => ModalDeps): BaseCtx & { menuOpener: HTMLElement | null } {
  const c = {
    path: location.pathname,
    menuOpener: null as HTMLElement | null,
    open: (key: ModalKey, opener: HTMLElement | null) => {
      if (key === 'menu') c.menuOpener = opener;
      openModal(modalBuild(key, deps()), opener);
    },
    onCleanup: (fn: () => void) => cleanups.push(fn),
  };
  return c;
}

// ── 퍼블리싱 화면(로비·굿즈 대기) ──
function renderPublishing(state: BoardState, opts: { focusHeading: boolean }): void {
  clear();
  let deps: ModalDeps;
  const b = baseCtx(() => deps);
  const ctx: Ctx = {
    ...b,
    state,
    go: (name) => {
      history.replaceState(null, '', stateHref(location.pathname, name, { theme: q.get('theme') ?? undefined }));
      const next = findState(name);
      if (next) renderPublishing(next, { focusHeading: true });
    },
  };
  let nodes: HTMLElement[];
  if (route.kind === 'goods') {
    const product = findProduct(route.id);
    deps = { cancelTo: links.product(product.id), openLogout: () => openModal(modalBuild('logout', deps), b.menuOpener) };
    document.title = `인기 MD 대기열 · ${product.name} · PEAKET`;
    nodes = goodsQueueScreen({ ...ctx, product });
  } else {
    const ev = findEvent(route.id);
    deps = { ev, cancelTo: links.event(ev.id), onRejoin: () => ctx.go('사람 확인 중') };
    document.title = `오픈 전 대기실 · ${ev.title} · PEAKET`;
    nodes = lobbyScreen({ ...ctx, ev });
  }
  // 저전력(배터리 15% 이하)은 움직임 줄이기와 같이 효과를 끈다(d5 §5.7). 퍼블리싱에서는 상태로 고른다
  document.body.className = cx('pk', dark && 'dark', state.name === '저전력' && 'q-still');
  root.replaceChildren(...nodes);
  if (opts.focusHeading) root.querySelector<HTMLElement>('h1')?.focus();
  if (state.name === '다른 기기 참가 409') openModal(modalBuild('rejoin', deps), root.querySelector<HTMLElement>('[data-opens="rejoin"]'));
  if (import.meta.env.DEV) void import('./dev/state-panel').then((m) => m.mountStatePanel({ route, current: state, dark }));
}

// ── 데이터 연결 화면(대기열·매진) ──
function startLive(eventId: string): void {
  let meta: EventMeta = emptyMeta(eventId);
  let view: QueueView = { state: 'boot' };
  let shape = '';
  let ctl: Controller | null = null;
  let deps: ModalDeps;
  const b = baseCtx(() => deps);

  const render = (): void => {
    // 화면 모양이 같으면 숫자만 고친다(열린 대화상자·초점·낭독을 지킨다)
    const nextShape = JSON.stringify([view.state, meta.title, meta.when, view.banner ?? '', !!view.purchaseUnlikely, view.rejoinAllowed ?? null, view.busyUntil ?? null, view.retryAt ?? null, view.ahead === undefined, view.state === 'offline' ? (view.lastSyncAt ?? null) : null]);
    if (nextShape === shape) {
      updateQueueNumbers(root, view);
      return;
    }
    const firstPaint = shape === '';
    shape = nextShape;
    clear();
    deps = { ev: meta, cancelTo: links.event(eventId), cancel: () => ctl?.cancel() ?? Promise.resolve(false), onRejoin: () => ctl?.rejoin(), openLogout: () => openModal(modalBuild('logout', deps), b.menuOpener) };
    const ctx: LiveCtx = { ...b, ev: meta, view, actions: { cancel: () => ctl?.cancel() ?? Promise.resolve(false), rejoin: () => ctl?.rejoin() } };
    const soldOut = view.state === 'sold-out';
    document.title = `${soldOut ? '매진' : '대기열'}${meta.title ? ` · ${meta.title}` : ''} · PEAKET`;
    document.body.className = cx('pk', dark && 'dark');
    root.replaceChildren(...(soldOut ? liveSoldOutScreen(ctx) : queueScreen(ctx)));
    // 끝 상태·매진으로 바뀌면 새 화면의 제목으로 초점을 옮긴다(d5 §5.18, §2.7). 처음 그림은 그대로
    if (!firstPaint) root.querySelector<HTMLElement>(soldOut ? '#so-h' : '.q-state-page h2')?.focus();
  };

  ctl = startQueue(browserEnv(eventId), (v) => {
    view = v;
    render();
  });
  // 머리의 공연명·회차·매진 화면의 다른 회차는 따로 받는다(대기열 경로를 막지 않는다)
  void createNet((u, i) => fetch(u, i), Date.now)
    .getPublic(`${ORIGINS.api}/v1/events/${encodeURIComponent(eventId)}`)
    .then((r) => {
      const m = r.status === 200 ? metaFromSummary(eventId, r.body) : null;
      if (m) {
        meta = m;
        render();
      }
    })
    .catch(() => undefined);
}

// 페이지 보관(bfcache)에서 되살아나면 상태 기계를 처음부터 다시 돌린다(입장 뒤 [뒤로] 등)
window.addEventListener('pageshow', (e) => {
  if (e.persisted) location.reload();
});

if (route.kind === 'goods') {
  renderPublishing(findState(q.get('state'), 'goods') ?? GOODS_STATES[0]!, { focusHeading: false });
} else {
  // 로비 퍼블리싱 상태는 개발 서버에서만 `?state=`로 연다(HOT-341이 잇기 전까지)
  const lobby = import.meta.env.DEV ? findState(q.get('state'), '007') : undefined;
  if (lobby) renderPublishing(lobby ?? LOBBY_STATES[0]!, { focusHeading: false });
  else startLive(route.id);
}
