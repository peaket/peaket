// 대기실 경량 페이지 진입점(docs/frontend.md §5.1). React 없이 상태표(§3.4) + DOM 갱신으로 그린다.
// 로비·대기열·매진(SCR-007·008·018)은 데이터에 이었다(ADR-0207·0208): 상태 기계(src/live/controller.ts)가 실제 응답으로 화면 값을 낸다.
// 굿즈 대기(SCR-015)는 아직 퍼블리싱이라 목업(fixtures)과 `?state=`로 그린다(굿즈 단계). 다크는 `?theme=dark`.
import '@peaket/ds/queue-room.css';
import './styles/app.css';
import { links, ORIGINS } from './config';
import type { AlertApi, AlertResult, BaseCtx, Ctx, LiveCtx, ModalKey, PrefApi } from './ctx';
import { alertDue, titlePrefix } from './live/alert.ts';
import { readPreference, writePreference } from './live/preference.ts';
import { cx } from './dom';
import { findProduct } from './fixtures';
import { browserEnv, refresh } from './live/browser';
import { createCancelAlert } from './live/cancel-alert.ts';
import { startQueue, type Controller, type QueueView, type Schedule } from './live/controller.ts';
import { clearForLogout, serverLogout } from './live/logout.ts';
import { emptyMeta, metaFromSummary, scheduleFromSummary, type EventMeta } from './live/meta.ts';
import { createNet } from './live/net.ts';
import { parseRoute } from './route';
import { goodsQueueScreen } from './screens/goods';
import { isLobbyView, lobbyScreen } from './screens/lobby';
import { modalBuild, type ModalDeps } from './screens/modals';
import { queueScreen, updateQueueNumbers, updateRestrictedLink } from './screens/queue';
import { liveSoldOutScreen } from './screens/soldout';
import { findState, GOODS_STATES, stateHref, type BoardState } from './states';
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

/** 저전력(배터리 15% 이하, 충전 중 아님)이면 움직임 줄이기와 같이 효과를 끈다(d5 §5.7, ADR-0208 결정 9). Battery Status API는 Chromium만 있다 */
let still = false;
function watchBattery(onChange: () => void): void {
  const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean; addEventListener(t: string, f: () => void): void }> };
  void nav.getBattery?.().then((b) => {
    const update = () => {
      const next = b.level <= 0.15 && !b.charging;
      if (next !== still) {
        still = next;
        onChange();
      }
    };
    b.addEventListener('levelchange', update);
    b.addEventListener('chargingchange', update);
    update();
  }, () => undefined);
}

// ── 퍼블리싱 화면(굿즈 대기) ──
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
  const product = findProduct(route.id);
  deps = { cancelTo: links.product(product.id), openLogout: () => openModal(modalBuild('logout', deps), b.menuOpener) };
  document.title = `인기 MD 대기열 · ${product.name} · PEAKET`;
  document.body.className = cx('pk', dark && 'dark');
  root.replaceChildren(...goodsQueueScreen({ ...ctx, product }));
  if (opts.focusHeading) root.querySelector<HTMLElement>('h1')?.focus();
  if (import.meta.env.DEV) void import('./dev/state-panel').then((m) => m.mountStatePanel({ route, current: state, dark }));
}

function storage(name: 'localStorage' | 'sessionStorage'): Storage | null {
  try {
    return window[name];
  } catch {
    return null;
  }
}

const logoutDeps = (broadcast: boolean) => ({
  local: storage('localStorage'),
  session: storage('sessionStorage'),
  idb: typeof indexedDB === 'undefined' ? null : indexedDB,
  caches: typeof caches === 'undefined' ? null : caches,
  serviceWorker: navigator.serviceWorker ?? null,
  broadcast: (name: string, msg: string) => {
    if (!broadcast) return;
    const ch = new BroadcastChannel(name);
    ch.postMessage(msg);
    ch.close();
  },
});

/** 로그아웃(§5.14.4 2~4번 뒤 같은 출처 POST /logout, ADR-0208 결정 7). 성공하면 홈으로. 부르기 전에 상태 기계를 멈춘다 */
async function logout(wallet: boolean): Promise<'ok' | 'failed'> {
  await clearForLogout(logoutDeps(true), { wallet });
  const r = await serverLogout((u, i) => fetch(u, i), links.logout());
  if (r === 'ok') location.assign(links.home());
  return r;
}

/** iOS·iPadOS에서 홈 화면 앱이 아니면 알림을 받을 수 없다(ADR-0212 결정 4) */
function iosNotInstalled(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios && !nav.standalone && !window.matchMedia('(display-mode: standalone)').matches;
}

// ── 데이터 연결 화면(로비·대기열·매진) ──
function startLive(eventId: string): void {
  let meta: EventMeta = emptyMeta(eventId);
  let view: QueueView = { state: 'boot' };
  let shape = '';
  let ctl: Controller | null = null;
  let deps: ModalDeps;
  const b = baseCtx(() => deps);
  let baseTitle = 'PEAKET';

  // [차례 알림 받기](CMP-068, ADR-0212 결정 4): 누른 동작 안에서 오디오를 열고 알림 권한을 묻는다. 켠 상태는 저장하지 않는다
  let alertsOn = false;
  let alerted = false;
  let lastResult: AlertResult | null = null;
  let audio: AudioContext | null = null;
  const alerts: AlertApi = {
    on: () => alertsOn,
    last: () => lastResult,
    iosInstall: iosNotInstalled,
    async enable(): Promise<AlertResult> {
      // 권한 요청을 사용자 동작 안에서 먼저 부른다(오디오를 기다리다 동작의 유효 시간이 지나면 브라우저가 막는다)
      let permission: Promise<NotificationPermission> | null = null;
      try {
        if (!iosNotInstalled() && typeof Notification !== 'undefined' && Notification.permission === 'default') permission = Notification.requestPermission();
      } catch {
        permission = null;
      }
      // 오디오는 같은 동작 안에서 열기만 하고 끝나기를 기다리지 않는다(iOS에서 끝나지 않을 수 있다)
      try {
        audio ??= new AudioContext();
        void audio.resume().catch(() => undefined);
      } catch {
        audio = null;
      }
      alertsOn = true;
      let r: AlertResult;
      if (iosNotInstalled()) r = 'ios-install';
      else if (typeof Notification === 'undefined') r = 'unsupported';
      else {
        try {
          const p = permission ? await permission : Notification.permission;
          r = p === 'granted' ? 'granted' : 'denied';
        } catch {
          r = 'unsupported';
        }
      }
      lastResult = r;
      return r;
    },
  };
  const ring = (): void => {
    try {
      if (audio) {
        const o = audio.createOscillator();
        const g = audio.createGain();
        o.frequency.value = 880;
        g.gain.value = 0.1;
        o.connect(g).connect(audio.destination);
        o.start();
        o.stop(audio.currentTime + 0.3);
      }
    } catch {
      /* 소리를 못 내면 넘긴다 */
    }
    try {
      // 다른 탭을 보고 있을 때만 띄운다. 안드로이드 크롬은 new Notification을 막는다(그때는 탭 제목·알림음만)
      if (document.visibilityState === 'hidden' && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        const n = new Notification('차례가 가까워졌습니다', { body: meta.title || '대기열', tag: `peaket-turn-${eventId}` });
        // 알림을 누르면 이 탭으로 돌아온다(보이는 탭이 리더가 되어 입장 확정을 보낸다)
        n.onclick = () => {
          window.focus();
          n.close();
        };
      }
    } catch {
      /* 넘긴다 */
    }
  };
  /** 탭 제목 카운트다운: 숨긴 탭이고 예상 대기 5분 안이면 남은 시간을 붙인다(대기 중일 때만, 곧 입장·유예는 그 화면이 제목을 고친다) */
  const applyTitle = (): void => {
    if (view.state !== 'waiting') return;
    document.title = `${titlePrefix(view.etaSec, document.visibilityState === 'hidden')}${baseTitle}`;
  };
  document.addEventListener('visibilitychange', applyTitle);

  /** 자동 배정 공연의 희망 조건(ADR-0212 결정 1). 직접 선택 공연이거나 등급을 모르면 없다 */
  const prefApi = (): PrefApi | null =>
    meta.autoAssign && meta.tiers.length > 0
      ? {
          tiers: meta.tiers,
          max: meta.perPersonLimit,
          read: () => readPreference(storage('localStorage'), eventId, meta.tiers, meta.perPersonLimit),
          save: (p) => writePreference(storage('localStorage'), eventId, p, Date.now()),
        }
      : null;

  const render = (): void => {
    // 화면 모양이 같으면 숫자만 고친다(열린 대화상자·초점·낭독을 지킨다)
    const nextShape = JSON.stringify([
      view.state, view.phase ?? null, view.via ?? null, view.openAt ?? null, view.joinAt ?? null, view.seedHash ?? null, view.offline ?? false, view.graceUntil ?? null,
      meta.title, meta.when, meta.openLabel, meta.autoAssign, (view.soldOutTiers ?? []).join(','), view.banner ?? '', !!view.purchaseUnlikely, view.rejoinAllowed ?? null, view.busyUntil ?? null, view.retryAt ?? null, view.ahead === undefined,
      view.state === 'offline' || view.offline ? (view.lastSyncAt ?? null) : null,
    ]);
    if (nextShape === shape) {
      updateQueueNumbers(root, view);
      updateRestrictedLink(root, view, eventId);
      return;
    }
    const firstPaint = shape === '';
    shape = nextShape;
    clear();
    const pref = prefApi();
    deps = {
      ev: meta,
      cancelTo: links.event(eventId),
      alerts,
      ...(pref
        ? {
            pref: {
              ...pref,
              // 저장하면 ⑧ 줄을 새 값으로 다시 그린다
              onSaved: () => {
                shape = '';
                render();
                // 다시 그린 ⑧ 줄의 [바꾸기]로 초점을 돌린다(닫힌 시트가 돌려준 옛 버튼은 지워졌다)
                root.querySelector<HTMLElement>('[data-opens="pref"]')?.focus();
              },
            },
          }
        : {}),
      cancel: () => ctl?.cancel() ?? Promise.resolve(false),
      onRejoin: () => ctl?.rejoin(),
      openLogout: () => openModal(modalBuild('logout', deps), b.menuOpener),
      // 정리하기 전에 상태 기계를 멈춘다(돌던 폴링·셔플 받기가 지운 저장소를 다시 채우지 않게, 새 맥락 리뷰 2026-11-05)
      logout: (wallet) => {
        ctl?.stop();
        return logout(wallet);
      },
    };
    const ctx: LiveCtx = {
      ...b,
      ev: meta,
      view,
      pref,
      cancelAlert,
      navigate: (u) => location.assign(u),
      actions: { cancel: () => ctl?.cancel() ?? Promise.resolve(false), rejoin: () => ctl?.rejoin(), retry: () => ctl?.retry(), admitNow: () => ctl?.admitNow() },
    };
    const lobby = isLobbyView(view);
    const soldOut = view.state === 'sold-out';
    const name = lobby ? '오픈 전 대기실' : soldOut ? '매진' : view.state === 'grace' ? '차례가 되었습니다' : '대기열';
    baseTitle = `${name}${meta.title ? ` · ${meta.title}` : ''} · PEAKET`;
    document.title = baseTitle;
    document.body.className = cx('pk', dark && 'dark', still && 'q-still');
    root.replaceChildren(...(lobby ? lobbyScreen(ctx) : soldOut ? liveSoldOutScreen(ctx) : queueScreen(ctx)));
    // 끝 상태·매진으로 바뀌면 새 화면의 제목으로 초점을 옮긴다(d5 §5.18, §2.7). 처음 그림은 그대로
    if (!firstPaint) root.querySelector<HTMLElement>(soldOut ? '#so-h' : '.q-state-page h2, #hc-h3')?.focus();
  };

  // 머리의 공연명·회차와 상태 기계의 일정(오픈·로비 개방)은 공연 공개 요약 하나에서 읽는다(ADR-0208 결정 2). 실패하면 다음에 다시 받는다
  const net = createNet((u, i) => fetch(u, i), Date.now);
  const cancelAlert = createCancelAlert({ net, api: ORIGINS.api, eventId, refresh });
  let summary: Promise<unknown> | null = null;
  let loaded: unknown = null;
  const schedule = async (): Promise<Schedule | null> => {
    if (!loaded) {
      summary ??= net
        .getPublic(`${ORIGINS.api}/v1/events/${encodeURIComponent(eventId)}`)
        .then((r) => (r.status === 200 ? r.body : null), () => null);
      const body = await summary;
      summary = null;
      const m = body ? metaFromSummary(eventId, body) : null;
      if (m) {
        loaded = body;
        meta = m;
        render();
      }
    }
    return loaded ? scheduleFromSummary(loaded) : null;
  };

  ctl = startQueue(browserEnv(eventId, schedule), (v) => {
    view = v;
    render();
    applyTitle();
    // 새로 줄을 서면(다시 줄 서기·다시 참가) 다시 알린다
    if (view.state === 'enter' || view.state === 'lobby-join' || view.state === 'batching') alerted = false;
    if (alertsOn && alertDue(view, alerted)) {
      alerted = true;
      ring();
    }
  });
  void schedule();
  // 저전력은 다시 그리지 않고 몸체 class만 바꾼다(다시 그리면 사람 확인 위젯 자리가 사라진다)
  watchBattery(() => document.body.classList.toggle('q-still', still));
  // 다른 탭(소비자 웹·대기실)의 로그아웃: 상태 기계를 멈추고 이 탭의 저장물도 지운 뒤 로그인 화면으로(§5.14.4 4번)
  try {
    const session = new BroadcastChannel('peaket.session');
    session.addEventListener('message', (e: MessageEvent<unknown>) => {
      if (e.data !== 'logout') return;
      ctl?.stop();
      void clearForLogout(logoutDeps(false), { wallet: false }).then(() => location.assign(links.login(location.pathname)));
    });
  } catch {
    /* BroadcastChannel이 없으면 넘긴다 */
  }
}

// 페이지 보관(bfcache)에서 되살아나면 상태 기계를 처음부터 다시 돌린다(입장 뒤 [뒤로] 등)
window.addEventListener('pageshow', (e) => {
  if (e.persisted) location.reload();
});

if (route.kind === 'goods') renderPublishing(findState(q.get('state'), 'goods') ?? GOODS_STATES[0]!, { focusHeading: false });
else startLive(route.id);
