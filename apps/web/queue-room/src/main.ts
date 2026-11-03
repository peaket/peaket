// 대기실 경량 페이지 진입점(docs/frontend.md §5.1). React 없이 상태표(§3.4) + DOM 갱신으로 그린다.
// 퍼블리싱 단계: 데이터는 목업(fixtures), 화면 상태는 `?state=`(캔버스 보드 상태 이름), 다크는 `?theme=dark`.
import '@peaket/ds/queue-room.css';
import './styles/app.css';
import { links } from './config';
import type { Ctx, ModalKey } from './ctx';
import { cx } from './dom';
import { findEvent, findProduct } from './fixtures';
import { boot } from './machine';
import { parseRoute } from './route';
import { goodsQueueScreen } from './screens/goods';
import { lobbyScreen } from './screens/lobby';
import { modalBuild, type ModalDeps } from './screens/modals';
import { QUEUE_OPEN_ON_LOAD, queueScreen } from './screens/queue';
import { soldOutScreen } from './screens/soldout';
import { defaultStateFor, findState, GOODS_STATES, stateHref, type BoardState } from './states';
import { closeModal, openModal } from './ui/modal';

const root = document.getElementById('root')!;
let cleanups: (() => void)[] = [];

function params(): URLSearchParams {
  return new URLSearchParams(location.search);
}

function render(opts: { focusHeading: boolean }): void {
  for (const f of cleanups) f();
  cleanups = [];
  closeModal(false);

  const q = params();
  const route = parseRoute(location.pathname);
  const dark = q.get('theme') === 'dark';
  let state: BoardState;
  let nodes: HTMLElement[];
  let deps: ModalDeps;
  let menuOpener: HTMLElement | null = null;

  const base = (st: BoardState): Ctx => ({
    state: st,
    path: location.pathname,
    go: (name) => {
      history.replaceState(null, '', stateHref(location.pathname, name, { theme: q.get('theme') ?? undefined }));
      render({ focusHeading: true });
    },
    open: (key: ModalKey, opener) => {
      if (key === 'menu') menuOpener = opener;
      openModal(modalBuild(key, deps), opener);
    },
    onCleanup: (fn) => cleanups.push(fn),
  });

  if (route.kind === 'goods') {
    const product = findProduct(route.id);
    state = findState(q.get('state'), 'goods') ?? GOODS_STATES[0]!;
    deps = { cancelTo: links.product(product.id), openLogout: () => openModal(modalBuild('logout', deps), menuOpener) };
    document.title = `인기 MD 대기열 · ${product.name} · PEAKET`;
    nodes = goodsQueueScreen({ ...base(state), product });
  } else {
    const ev = findEvent(route.id);
    const asked = findState(q.get('state'));
    state = asked && asked.screen !== 'goods' ? asked : defaultStateFor(boot(ev));
    const ctx = { ...base(state), ev };
    deps = { ev, cancelTo: links.event(ev.id), onRejoin: () => ctx.go('사람 확인 중') };
    if (state.screen === '007') {
      document.title = `오픈 전 대기실 · ${ev.title} · PEAKET`;
      nodes = lobbyScreen(ctx);
    } else if (state.screen === '018') {
      document.title = `매진 · ${ev.title} · PEAKET`;
      nodes = soldOutScreen(ctx);
    } else {
      document.title = `대기열 · ${ev.title} · PEAKET`;
      nodes = queueScreen(ctx);
    }
  }

  // 저전력(배터리 15% 이하)은 움직임 줄이기와 같이 효과를 끈다(d5 §5.7). 퍼블리싱에서는 상태로 고른다
  document.body.className = cx('pk', dark && 'dark', state.name === '저전력' && 'q-still');
  root.replaceChildren(...nodes);

  // 매진 화면을 처음부터 열면 h1로 초점을 옮겨 제목을 읽게 한다(d5 §5.18). 시연 전환 뒤에는 새 화면의 h1로(§2.7)
  if (opts.focusHeading || state.screen === '018') root.querySelector<HTMLElement>('h1')?.focus();

  // 시트·대화상자가 열린 채로 그리는 상태(보드 그대로). 닫으면 그 시트를 여는 버튼으로 초점이 돌아간다
  const openKey = state.name === '다른 기기 참가 409' ? 'rejoin' : QUEUE_OPEN_ON_LOAD[state.name];
  if (openKey) {
    const opener = root.querySelector<HTMLElement>(`[data-opens="${openKey}"]`);
    openModal(modalBuild(openKey, deps), opener);
  }

  if (import.meta.env.DEV) {
    void import('./dev/state-panel').then((m) => m.mountStatePanel({ route, current: state, dark }));
  }
}

render({ focusHeading: false });
