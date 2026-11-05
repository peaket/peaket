// SCR-008 대기열(오픈 후). 캔버스 SCR-008 m·t·d 보드를 한 페이지의 반응형으로 옮겼다(d5 §5.8).
// 화면 값은 상태 기계(src/live/controller.ts)가 실제 응답으로 낸다(ADR-0207). 기본 네 가지: ① 앞 인원 ③ 진행 막대 ② 남은 예상 시간 ⑦ [대기 취소].
// 나머지는 생길 때만 뜬다(ADR-0063). 자동 배정 희망 조건·차례 도래 유예는 HOT-341이 잇는다.
import { links } from '../config';
import type { LiveCtx } from '../ctx';
import type { QueueView } from '../live/controller.ts';
import { append, cx, h, ic, setVars } from '../dom';
import { fmt, queueSentence } from '../queue-math';
import { announceEveryMinute, countdown } from '../ui/timers';
import { focusHeader, offlineStrip } from './shell';

/** 예상 대기 글(분으로 반올림, 1분 미만도 약 1분, 60분부터 시간, ADR-0207 결정 9). null이면 숨김 */
export function etaLabel(sec: number | null | undefined): string | null {
  if (sec === null || sec === undefined) return null;
  const minutes = Math.max(1, Math.round(sec / 60));
  if (minutes < 60) return `약 ${minutes}분`;
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return mm ? `약 ${hh}시간 ${mm}분` : `약 ${hh}시간`;
}

const hhmm = (ms: number): string => {
  const d = new Date(ms + 9 * 3600_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

export function queueScreen(c: LiveCtx): HTMLElement[] {
  const v = c.view;
  const ev = c.ev;
  const st = v.state;
  const terminal = ['expired', 'cancelled-elsewhere', 'already-admitted', 'login-expired', 'ended', 'duplicate', 'restricted', 'other-device'].includes(st);
  const loading = st === 'enter' || st === 'boot' || st === 'leaving' || st === 'admitted' || st === 'turn';
  const hasCount = v.ahead !== undefined && (st === 'waiting' || st === 'stale' || st === 'paused' || st === 'all-held' || st === 'offline');

  const main = h('main', { class: 'page-main q-main q-queue', id: 'main' });
  const frame = h('div', { class: 'col q-frame q-queue-frame' }, h('h1', { class: 'sr-only', tabindex: '-1' }, '대기열'));
  main.append(frame);

  if (!terminal) {
    const inQueue = h('div', { class: 'col q-inqueue' });
    frame.append(inQueue);

    // 생길 때만 ①~② 위에 뜨는 안내
    if (v.banner) {
      inQueue.append(h('div', { class: 'banner banner-announce', role: 'status' }, ic('megaphone'), h('div', { class: 'banner-body' }, h('span', { class: 'banner-title' }, '운영 공지'), v.banner)));
    }
    if (st === 'paused') {
      inQueue.append(h('div', { class: 'banner banner-warning', role: 'status' }, ic('pause'), h('div', { class: 'banner-body fw-b' }, '판매가 잠시 멈췄습니다. 대기 순서는 그대로입니다')));
    }
    if (st === 'all-held') {
      inQueue.append(h('div', { class: 'banner banner-info', role: 'status' }, ic('seat'), h('div', { class: 'banner-body fw-b' }, '남은 좌석이 모두 결제 중입니다. 결제되지 않은 좌석이 풀리면 차례대로 이어집니다')));
    }
    if (v.purchaseUnlikely) {
      inQueue.append(h('div', { class: 'banner banner-warning', role: 'status' }, ic('alert'), h('div', { class: 'banner-body' }, '현재 순번으로는 구매가 어려울 수 있습니다')));
    }

    const region = h('section', { class: 'col q-region', role: 'region', 'aria-label': '대기 상태' });
    inQueue.append(region);

    if (st === 'stale') region.append(h('p', { class: 'row t-sm fw-b q-jc', role: 'status' }, h('span', { class: 'spinner muted', 'aria-hidden': 'true' }), '연결 확인 중'));
    if (loading) region.append(spinnerBlock('muted', h('p', { class: 't-lg', role: 'status' }, st === 'turn' ? '입장 중' : '순번 확인 중')));
    if (st === 'enter' && v.busyUntil !== undefined) region.append(busyLine(c, v.busyUntil));
    if (st === 'stale' && v.ahead === undefined) region.append(spinnerBlock('muted', h('p', { class: 't-lg' }, '순번 확인 중')));
    if (hasCount) {
      const eta = etaLabel(v.etaSec);
      const allHeld = st === 'all-held';
      region.append(countBlock(c, { ahead: v.ahead!, pct: Math.round(v.progress ?? 0), eta, sentence: queueSentence(v.ahead!, eta, allHeld), stale: st === 'stale', allHeld, paused: st === 'paused' }));
    }
    if (st === 'batching') region.append(spinnerBlock('tx-link', h('p', { class: 't-lg', role: 'status' }, '순서를 정하는 중입니다. 이 동안에는 순번이 보이지 않습니다')));
    if (st === 'soon') region.append(soonBlock(c, v.retryAt ?? Date.now()));
    if (st === 'verify-redirect') {
      region.append(h('div', { class: 'col q-center-block q-g16' },
        h('span', { class: 'state-icon is-primary' }, ic('shield')),
        h('p', { class: 't-lg', role: 'status' }, '자동으로 확인된 사항이 있어 한 번 더 확인합니다. 통과하면 원래 순번의 차례에 입장합니다'),
        h('span', { class: 'spinner muted', 'aria-hidden': 'true' }),
      ));
    }
    // ⑦ 대기 취소(확인 대화상자 뒤 DELETE entries/me)
    if (st !== 'verify-redirect' && st !== 'admitted' && st !== 'leaving') {
      const cancel = h('button', { class: 'btn btn-text q-self-center', type: 'button', 'aria-haspopup': 'dialog', 'data-opens': 'cancel' }, '대기 취소');
      cancel.addEventListener('click', () => c.open('cancel', cancel));
      region.append(cancel);
    }

    // ⑨ 순번 안내 ›. ⑥ [차례 알림 받기](알림 권한·알림음·웹 푸시)는 HOT-341이 잇기 전까지 보이지 않는다(ADR-0207 결정 12)
    const info = h('button', { class: 'btn btn-text btn-sm q-mh32', type: 'button', 'aria-haspopup': 'dialog', 'data-opens': 'info' }, '순번 안내', ic('chevron-right', 'ic-16'));
    info.addEventListener('click', () => c.open('info', info));
    inQueue.append(h('div', { class: 'col q-queue-foot' }, info));
  }

  if (st === 'expired') {
    frame.append(statePage('is-danger', 'clock', '차례가 지난 지 15분이 넘어 대기표가 만료됐습니다', v.rejoinAllowed ? '다시 줄을 서면 맨 뒤 순번을 받습니다' : null,
      h('div', { class: 'col q-g10 q-cta q-mt8' },
        v.rejoinAllowed ? h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', onclick: () => c.actions.rejoin() }, '다시 줄 서기') : null,
        h('a', { class: 'btn btn-outline btn-lg btn-block', href: links.event(ev.id) }, '공연 상세', ic('chevron-right')),
      )));
  }
  if (st === 'other-device') {
    const again = h('button', { class: 'link-more', type: 'button', onclick: () => c.actions.rejoin() }, '이 기기에서 다시 참가', ic('chevron-right'));
    frame.append(statePage('', 'device', '다른 기기나 탭에서 이미 대기 중입니다', '처음 기기에서 계속하세요', h('div', { class: 'col q-g10 q-cta q-mt8 q-ai-center' }, again)));
  }
  if (st === 'cancelled-elsewhere') frame.append(statePage('', 'device', '다른 기기에서 이 대기를 취소했습니다', null, linkBtn(links.event(ev.id), '공연 상세')));
  if (st === 'already-admitted') frame.append(statePage('is-primary', 'ticket', '이 회차에는 이미 입장했습니다. 같은 회차에는 다시 줄을 설 수 없습니다', null, linkBtn(links.orders(), '예매 내역')));
  if (st === 'login-expired') {
    frame.append(statePage('', 'lock', '로그인이 만료되었습니다', '다시 로그인해도 순번은 그대로입니다',
      h('button', { class: 'btn btn-secondary btn-lg btn-block q-cta q-mt8', type: 'button', onclick: () => location.assign(links.login(c.path)) }, '다시 로그인')));
  }
  if (st === 'ended') frame.append(statePage('', 'calendar', '판매 시간이 끝났습니다', null, linkBtn(links.event(ev.id), '다른 회차')));
  // ( 소명하기 › )의 소명 건 ID는 403에 없어 공연 상세의 제한 표시(HOT-342)로 보낸다
  if (st === 'restricted') frame.append(statePage('is-danger', 'ban', '예매가 제한되어 있어 입장할 수 없습니다', null, linkBtn(links.event(ev.id), '공연 상세')));
  if (st === 'duplicate') frame.append(statePage('', 'device', '이미 다른 기기나 탭의 대기표로 입장했습니다', '처음 입장한 곳에서 계속하세요', null));

  const offline = st === 'offline' ? offlineStrip(v.lastSyncAt !== undefined ? `인터넷 연결이 없습니다 · 마지막 동기화 ${hhmm(v.lastSyncAt)}` : '인터넷 연결이 없습니다') : null;
  return [offline, focusHeader(c), main].filter((x): x is HTMLElement => x !== null);
}

function linkBtn(href: string, text: string): HTMLElement {
  return h('a', { class: 'btn btn-outline btn-lg btn-block q-cta q-mt8', href }, text, ic('chevron-right'));
}

/** CMP-045 page: 대기 화면 대신 보이는 끝 상태 */
function statePage(tone: string, icon: string, title: string, sub: string | null, action: HTMLElement | null): HTMLElement {
  return h('section', { class: 'state q-state-page', role: 'alert' },
    h('span', { class: cx('state-icon', tone) }, ic(icon)),
    h('h2', { class: 't-lg', tabindex: '-1' }, title),
    sub && h('p', { class: 't-sm muted' }, sub),
    action,
  );
}

function spinnerBlock(tone: string, text: HTMLElement): HTMLElement {
  return h('div', { class: 'col q-center-block q-g16' }, h('span', { class: cx('spinner q-spin-lg', tone), 'aria-hidden': 'true' }), text);
}

/** 진입 혼잡(429): "요청이 많아 잠시 기다려야 합니다. N초 뒤 자동으로 다시 시도합니다"(d5 '진입 혼잡') */
function busyLine(c: LiveCtx, until: number): HTMLElement {
  const secs = h('span', { class: 'num fw-b' }, `${Math.max(1, Math.ceil((until - Date.now()) / 1000))}초`);
  c.onCleanup(countdown(until, (sec) => (secs.textContent = `${sec}초`), () => undefined));
  // 남은 초는 매초 바뀌므로 낭독 영역 밖에 두고, 낭독은 한 번만 한다(숫자에 live를 두지 않는다, ADR-0063)
  return h('p', { class: 't-sm muted q-jc' },
    h('span', { class: 'sr-only', role: 'status' }, '요청이 많아 잠시 기다려야 합니다. 곧 자동으로 다시 시도합니다'),
    h('span', { 'aria-hidden': 'true' }, '요청이 많아 잠시 기다려야 합니다. ', secs, ' 뒤 자동으로 다시 시도합니다'),
  );
}

/** '나' 표시(막대 위 배지와 눈금). 진행률만큼 transform으로 옮긴다(d5 §5.8: 움직임은 transform·opacity만) */
function meMarker(pct: number): HTMLElement {
  const track = h('span', { class: 'q-me', 'aria-hidden': 'true' },
    h('span', { class: 'badge badge-solid q-me-badge' }, '나'),
    h('span', { class: 'q-me-tick' }),
  );
  setVars(track, { '--p': `${pct}%` });
  return track;
}

/** ③ 진행 막대(CMP-016 queue). 채움은 transform으로 옮기고, 흐름 효과는 막대 안 줄무늬가 transform으로 흐른다 */
function bar(pct: number, valueText: string, opts: { flow: boolean; dim: boolean }): HTMLElement {
  const fill = h('span', { class: cx('q-fill', opts.flow && 'q-flow', opts.dim && 'q-dim') });
  setVars(fill, { '--p': `${pct}%` });
  return h('div', {
    class: 'progress progress-lg q-bar',
    role: 'progressbar',
    'aria-label': '대기 진행',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-valuenow': String(pct),
    'aria-valuetext': valueText,
  }, fill);
}

function countBlock(c: LiveCtx, v: { ahead: number; pct: number; eta: string | null; sentence: string; stale: boolean; allHeld: boolean; paused: boolean }): HTMLElement {
  const tone = v.stale ? 'muted' : '';
  // 속도가 0이거나 일시정지면 숫자 대신 '잠시 멈춤'(frontend §3.4). 멈춘 동안 막대도 흐르지 않는다
  const etaValue = v.eta ?? '잠시 멈춤';
  // 낭독은 live 영역 하나가 1분에 한 번 같은 문장을 읽는다. 앞 인원 숫자 자체에는 live를 두지 않는다(ADR-0063)
  const live = h('p', { class: 'sr-only', 'aria-live': 'polite' });
  // 새 값이 와도 다시 그리지 않고 제자리에서 고친다(updateQueueNumbers). 낭독 문장은 마지막 값을 읽는다
  const block = h('div', { class: 'col q-count', 'data-sentence': v.sentence });
  c.onCleanup(announceEveryMinute(live, () => block.getAttribute('data-sentence') ?? v.sentence));
  append(block, [
    h('p', { class: 'row q-ahead' }, h('span', { class: cx('t-lg fw-b q-ahead-l', tone) }, '앞에'), h('span', { class: cx('t-display num', tone), 'data-q': 'ahead' }, `${fmt(v.ahead)}명`)),
    h('div', { class: 'q-barwrap' }, meMarker(v.pct), bar(v.pct, v.sentence, { flow: !v.stale && !v.paused, dim: v.stale })),
    !v.allHeld && h('div', { class: 'col q-eta' }, h('span', { class: 't-sm muted' }, '예상 대기 시간'), h('strong', { class: cx('t-xl', v.eta && 'num', tone), 'data-q': 'eta' }, etaValue)),
    v.allHeld && h('p', { class: 'row t-md fw-b q-jc' }, h('span', { class: 'spinner muted', 'aria-hidden': 'true' }), '좌석이 풀리길 기다리는 중'),
    live,
  ]);
  return block;
}

/**
 * 같은 모양의 화면에서 숫자만 바뀌면 다시 그리지 않고 고친다(열린 대화상자·초점·낭독을 지킨다). 고쳤으면 true,
 * 숫자 칸이 없으면 false(다시 그려야 한다)
 */
export function updateQueueNumbers(root: HTMLElement, v: QueueView): boolean {
  const block = root.querySelector<HTMLElement>('.q-count');
  if (!block || v.ahead === undefined) return false;
  const eta = etaLabel(v.etaSec);
  const pct = Math.round(v.progress ?? 0);
  const sentence = queueSentence(v.ahead, eta, v.state === 'all-held');
  block.setAttribute('data-sentence', sentence);
  const ahead = block.querySelector<HTMLElement>('[data-q="ahead"]');
  if (ahead) ahead.textContent = `${fmt(v.ahead)}명`;
  const etaEl = block.querySelector<HTMLElement>('[data-q="eta"]');
  if (etaEl) {
    etaEl.textContent = eta ?? '잠시 멈춤';
    etaEl.classList.toggle('num', eta !== null);
  }
  const me = block.querySelector<HTMLElement>('.q-me');
  if (me) setVars(me, { '--p': `${pct}%` });
  const fill = block.querySelector<HTMLElement>('.q-fill');
  if (fill) setVars(fill, { '--p': `${pct}%` });
  const barEl = block.querySelector<HTMLElement>('[role="progressbar"]');
  barEl?.setAttribute('aria-valuenow', String(pct));
  barEl?.setAttribute('aria-valuetext', sentence);
  return true;
}

/** soon: "곧 입장합니다" + 자동 재시도까지 남은 초. 탭 제목에도 남은 초를 보인다(d5 §5.8) */
function soonBlock(c: LiveCtx, retryAt: number): HTMLElement {
  const secs = h('span', { class: 'num fw-b' }, `${Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))}초`);
  const baseTitle = document.title;
  const stop = countdown(retryAt, (sec) => {
    secs.textContent = `${sec}초`;
    document.title = `(${sec}초) 곧 입장${c.ev.title ? ` · ${c.ev.title}` : ''}`;
  }, () => undefined);
  c.onCleanup(() => {
    stop();
    document.title = baseTitle;
  });
  return h('div', { class: 'col q-center-block q-g12' },
    h('span', { class: 'state-icon is-primary' }, ic('bell')),
    h('p', { class: 't-2xl', role: 'alert' }, '곧 입장합니다'),
    h('p', { class: 't-md' }, secs, ' 뒤 자동으로 다시 시도합니다'),
    h('p', { class: 't-sm muted' }, '다른 탭을 보고 있어도 탭 제목에 남은 초가 보입니다'),
  );
}
