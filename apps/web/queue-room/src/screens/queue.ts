// SCR-008 대기열(오픈 후). 캔버스 SCR-008 m·t·d 보드를 한 페이지의 반응형으로 옮겼다(d5 §5.8).
// 기본 네 가지: ① 앞 인원(display) ③ 진행 막대(CMP-016 queue) ② 남은 예상 시간 ⑦ [대기 취소]. 나머지는 생길 때만 뜬다(ADR-0063).
import { links } from '../config';
import type { EventCtx } from '../ctx';
import { cx, h, ic, setVars } from '../dom';
import { aheadCount, clock, etaText, fmt, progressPercent, queueSentence } from '../queue-math';
import { announceEveryMinute, countdown } from '../ui/timers';
import { focusHeader, offlineStrip } from './shell';

/** 시트·대화상자가 열린 채로 그리는 상태 → 여는 버튼 */
export const QUEUE_OPEN_ON_LOAD: Record<string, 'cancel' | 'info' | 'pref'> = {
  '대기 취소 확인': 'cancel',
  '순번 안내 시트': 'info',
  '순번 안내 시트 — 선착순': 'info',
  '희망 조건 바꾸기 시트': 'pref',
};

export function queueScreen(c: EventCtx): HTMLElement[] {
  const st = c.state.name;
  const ev = c.ev;
  const batching = st === '순서를 정하는 중';
  const soon = st === '곧 입장';
  const stale = st === '연결 확인 중';
  const expired = st === '대기표 만료';
  const rolling = st === '값이 바뀌는 순간';
  const other = st === '다른 기기에서 취소';
  const verify = st === '추가 검증';
  const admitted = st === '이미 입장';
  const loginExp = st === '로그인 만료';
  const ended = st === '판매 종료';
  const loading = st === '순번 확인 중';
  const grace = st === '차례 도래 유예';
  const tierOut = st === '1순위 등급 매진';
  const invalid = st === '다른 곳에서 이미 입장';
  const allHeld = st === '일시 매진';
  const restricted = st === '예매 제한(입장 확정 403)';
  const offline = st === '연결 끊김';
  const terminal = expired || other || admitted || loginExp || ended || invalid || restricted;
  const showCount = !batching && !soon && !verify && !rolling && !terminal && !loading && !grace;

  // 대기 상태 파일(목업 고정 값)에서 브라우저가 계산한다(§2.6·§3.4). 일시정지 상태는 판매 중 파일을 PAUSED로 바꿔 읽는다
  const paused = st === '일시정지';
  const status = paused ? { ...ev.status, saleStatus: 'PAUSED' as const } : ev.status;
  const ahead = aheadCount(ev.myNumber, status);
  const pct = Math.round(progressPercent(ev.initialAhead, ahead));
  const eta = etaText(ahead, status);
  const sentence = queueSentence(ahead, eta, allHeld);

  const main = h('main', { class: 'page-main q-main q-queue', id: 'main' });
  const frame = h('div', { class: 'col q-frame q-queue-frame' }, h('h1', { class: 'sr-only', tabindex: '-1' }, '대기열'));
  main.append(frame);

  if (!terminal) {
    const inQueue = h('div', { class: 'col q-inqueue' });
    frame.append(inQueue);

    // 생길 때만 ①~② 위에 뜨는 안내
    if (st === '운영 공지' && ev.notice) {
      inQueue.append(h('div', { class: 'banner banner-announce', role: 'status' }, ic('megaphone'), h('div', { class: 'banner-body' }, h('span', { class: 'banner-title' }, '운영 공지'), ev.notice)));
    }
    if (st === '일시정지') {
      inQueue.append(h('div', { class: 'banner banner-warning', role: 'status' }, ic('pause'), h('div', { class: 'banner-body fw-b' }, '판매가 잠시 멈췄습니다. 대기 순서는 그대로입니다')));
    }
    if (allHeld) {
      inQueue.append(h('div', { class: 'banner banner-info', role: 'status' }, ic('seat'), h('div', { class: 'banner-body fw-b' }, '남은 좌석이 모두 결제 중입니다. 결제되지 않은 좌석이 풀리면 차례대로 이어집니다')));
    }
    if (st === '구매가 어려울 수 있음') {
      inQueue.append(h('div', { class: 'banner banner-warning', role: 'status' }, ic('alert'), h('div', { class: 'banner-body' }, '현재 순번으로는 구매가 어려울 수 있습니다')));
    }
    // ⑧ 자동 배정 공연의 희망 조건 한 줄 요약
    if (ev.autoAssign && !tierOut) {
      const change = h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'aria-haspopup': 'dialog', 'aria-describedby': 'pf-sum', 'data-opens': 'pref' }, '바꾸기');
      change.addEventListener('click', () => c.open('pref', change));
      inQueue.append(h('div', { class: 'card-flat row between q-pref-row' },
        h('p', { class: 't-sm q-pref-text', id: 'pf-sum' }, h('span', { class: 'muted' }, '희망'), ' ', h('strong', null, `${ev.pref.tier} ${ev.pref.qty}매`)),
        change,
      ));
    }
    if (tierOut) {
      const change = h('button', { class: 'btn btn-outline btn-sm', type: 'button', 'aria-haspopup': 'dialog', 'aria-describedby': 'pf-out', 'data-opens': 'pref' }, '바꾸기');
      change.addEventListener('click', () => c.open('pref', change));
      inQueue.append(h('div', { class: 'card-flat row between q-pref-row', role: 'status' },
        h('p', { class: 't-sm row q-pref-text q-top', id: 'pf-out' }, ic('alert', 'tx-warning'), h('span', null, '1순위 등급이 매진되었습니다. 2순위 등급을 골라 두세요')),
        change,
      ));
    }

    const region = h('section', { class: 'col q-region', role: 'region', 'aria-label': '대기 상태' });
    inQueue.append(region);

    if (stale) region.append(h('p', { class: 'row t-sm fw-b q-jc', role: 'status' }, h('span', { class: 'spinner muted', 'aria-hidden': 'true' }), '연결 확인 중'));
    if (loading) region.append(spinnerBlock('muted', h('p', { class: 't-lg', role: 'status' }, '순번 확인 중')));
    if (showCount) region.append(countBlock(c, { ahead, pct, eta, sentence, stale, allHeld, paused }));
    if (rolling) region.append(rollingBlock(ahead, eta, sentence));
    if (batching) region.append(spinnerBlock('tx-link', h('p', { class: 't-lg', role: 'status' }, '순서를 정하는 중입니다. 이 동안에는 순번이 보이지 않습니다')));
    if (soon) region.append(soonBlock(c));
    if (grace) region.append(graceBlock(c));
    if (verify) {
      region.append(h('div', { class: 'col q-center-block q-g16' },
        h('span', { class: 'state-icon is-primary' }, ic('shield')),
        h('p', { class: 't-lg', role: 'status' }, '자동으로 확인된 사항이 있어 한 번 더 확인합니다. 통과하면 원래 순번의 차례에 입장합니다'),
        h('span', { class: 'spinner muted', 'aria-hidden': 'true' }),
      ));
    }
    // ⑦ 대기 취소(확인 대화상자 뒤 취소)
    if (!verify) {
      const cancel = h('button', { class: 'btn btn-text q-self-center', type: 'button', 'aria-haspopup': 'dialog', 'data-opens': 'cancel' }, '대기 취소');
      cancel.addEventListener('click', () => c.open('cancel', cancel));
      region.append(cancel);
    }

    // ⑥ 차례 알림 받기 · ⑨ 순번 안내 ›
    const notify = h('button', { class: 'btn btn-secondary', type: 'button', 'aria-haspopup': 'dialog' }, ic('bell'), '차례 알림 받기');
    notify.addEventListener('click', () => c.open('notify', notify));
    const info = h('button', { class: 'btn btn-text btn-sm q-mh32', type: 'button', 'aria-haspopup': 'dialog', 'data-opens': 'info' }, '순번 안내', ic('chevron-right', 'ic-16'));
    info.addEventListener('click', () => c.open('info', info));
    inQueue.append(h('div', { class: 'col q-queue-foot' }, notify, info));
  }

  if (expired) {
    frame.append(statePage('is-danger', 'clock', '차례가 지난 지 15분이 넘어 대기표가 만료됐습니다', '다시 줄을 서면 맨 뒤 순번을 받습니다',
      h('div', { class: 'col q-g10 q-cta q-mt8' },
        h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', onclick: () => c.go('순번 확인 중') }, '다시 줄 서기'),
        h('a', { class: 'btn btn-outline btn-lg btn-block', href: links.event(ev.id) }, '공연 상세', ic('chevron-right')),
      )));
  }
  if (other) frame.append(statePage('', 'device', '다른 기기에서 이 대기를 취소했습니다', null, linkBtn(links.event(ev.id), '공연 상세')));
  if (admitted) frame.append(statePage('is-primary', 'ticket', '이 회차에는 이미 입장했습니다. 같은 회차에는 다시 줄을 설 수 없습니다', null, linkBtn(links.orders(), '예매 내역')));
  if (loginExp) {
    frame.append(statePage('', 'lock', '로그인이 만료되었습니다', '다시 로그인해도 순번은 그대로입니다',
      h('button', { class: 'btn btn-secondary btn-lg btn-block q-cta q-mt8', type: 'button', onclick: () => location.assign(links.login(c.path)) }, '다시 로그인')));
  }
  if (ended) frame.append(statePage('', 'calendar', '판매 시간이 끝났습니다', null, linkBtn(links.event(ev.id), '다른 회차')));
  if (restricted) frame.append(statePage('is-danger', 'ban', '예매가 제한되어 있어 입장할 수 없습니다', null, linkBtn(links.appeal(ev.appealId), '소명하기')));
  if (invalid) frame.append(statePage('', 'device', '이미 다른 기기나 탭의 대기표로 입장했습니다', '처음 입장한 곳에서 계속하세요', null));

  return [offline ? offlineStrip(`인터넷 연결이 없습니다 · 마지막 동기화 20:03`) : null, focusHeader(c), main]
    .filter((x): x is HTMLElement => x !== null);
}

function linkBtn(href: string, text: string): HTMLElement {
  return h('a', { class: 'btn btn-outline btn-lg btn-block q-cta q-mt8', href }, text, ic('chevron-right'));
}

/** CMP-045 page: 대기 화면 대신 보이는 끝 상태 */
function statePage(tone: string, icon: string, title: string, sub: string | null, action: HTMLElement | null): HTMLElement {
  return h('section', { class: 'state q-state-page', role: 'alert' },
    h('span', { class: cx('state-icon', tone) }, ic(icon)),
    h('h2', { class: 't-lg' }, title),
    sub && h('p', { class: 't-sm muted' }, sub),
    action,
  );
}

function spinnerBlock(tone: string, text: HTMLElement): HTMLElement {
  return h('div', { class: 'col q-center-block q-g16' }, h('span', { class: cx('spinner q-spin-lg', tone), 'aria-hidden': 'true' }), text);
}

/** '나' 표시(막대 위 배지와 눈금). 진행률만큼 transform으로 옮긴다(d5 §5.8: 움직임은 transform·opacity만) */
function meMarker(pct: number, ghost = false): HTMLElement {
  const track = h('span', { class: cx('q-me', ghost && 'q-me-ghost'), 'aria-hidden': 'true' },
    h('span', { class: 'badge badge-solid q-me-badge' }, '나'),
    !ghost && h('span', { class: 'q-me-tick' }),
  );
  setVars(track, { '--p': `${pct}%` });
  return track;
}

/** ③ 진행 막대(CMP-016 queue). 채움은 transform으로 옮기고, 흐름 효과는 막대 안 줄무늬가 transform으로 흐른다 */
function bar(pct: number, valueText: string, opts: { flow: boolean; dim: boolean; extra?: HTMLElement; valueNow?: number }): HTMLElement {
  const fill = h('span', { class: cx('q-fill', opts.flow && 'q-flow', opts.dim && 'q-dim') });
  setVars(fill, { '--p': `${pct}%` });
  return h('div', {
    class: 'progress progress-lg q-bar',
    role: 'progressbar',
    'aria-label': '대기 진행',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-valuenow': String(opts.valueNow ?? pct),
    'aria-valuetext': valueText,
  }, fill, opts.extra);
}

function countBlock(c: EventCtx, v: { ahead: number; pct: number; eta: string | null; sentence: string; stale: boolean; allHeld: boolean; paused: boolean }): HTMLElement {
  const tone = v.stale ? 'muted' : '';
  // 속도가 0이거나 일시정지면 숫자 대신 '잠시 멈춤'(frontend §3.4). 멈춘 동안 막대도 흐르지 않는다
  const etaValue = v.eta ?? '잠시 멈춤';
  // 낭독은 live 영역 하나가 1분에 한 번 같은 문장을 읽는다. 앞 인원 숫자 자체에는 live를 두지 않는다(ADR-0063)
  const live = h('p', { class: 'sr-only', 'aria-live': 'polite' });
  c.onCleanup(announceEveryMinute(live, () => v.sentence));
  return h('div', { class: 'col q-count' },
    h('p', { class: 'row q-ahead' }, h('span', { class: cx('t-lg fw-b q-ahead-l', tone) }, '앞에'), h('span', { class: cx('t-display num', tone) }, `${fmt(v.ahead)}명`)),
    h('div', { class: 'q-barwrap' }, meMarker(v.pct), bar(v.pct, v.sentence, { flow: !v.stale && !v.paused, dim: v.stale })),
    !v.allHeld && h('div', { class: 'col q-eta' }, h('span', { class: 't-sm muted' }, '예상 대기 시간'), h('strong', { class: cx('t-xl', v.eta && 'num', tone) }, etaValue)),
    v.allHeld && h('p', { class: 'row t-md fw-b q-jc' }, h('span', { class: 'spinner muted', 'aria-hidden': 'true' }), '좌석이 풀리길 기다리는 중'),
    live,
  );
}

/** '값이 바뀌는 순간'(보드): 앞 인원이 줄 때 바뀐 자리 숫자가 굴러 내려오고, '나' 표시가 앞으로 나아간다. 움직임 줄이기면 바로 바뀐다 */
function rollingBlock(ahead: number, eta: string | null, sentence: string): HTMLElement {
  const prevAhead = 3_640; // 직전 파일의 앞 인원(보드 그림의 이전 숫자)
  const prevPct = 57;
  const nowPct = 62;
  const now = fmt(ahead);
  const before = fmt(prevAhead).padStart(now.length, ' ');
  const digits = [...now].map((ch, i) => {
    const old = before[i] ?? ch;
    if (ch === old) return ch;
    return h('span', { class: 'q-digit' }, h('span', { class: 'q-digit-stack' }, h('span', null, ch), h('span', { class: 'q-digit-old' }, old)));
  });
  const next = h('span', { class: 'q-fill-next', 'aria-hidden': 'true' });
  setVars(next, { '--from': `${prevPct}%`, '--w': `${nowPct - prevPct}%` });
  return h('div', { class: 'col q-count' },
    h('p', { class: 'row q-ahead' },
      h('span', { class: 't-lg fw-b q-ahead-l' }, '앞에'),
      h('span', { class: 'sr-only' }, `${now}명`),
      h('span', { class: 't-display num q-roll', 'aria-hidden': 'true' }, digits, '명'),
    ),
    h('div', { class: 'q-barwrap' }, meMarker(prevPct, true), meMarker(nowPct), bar(prevPct, sentence, { flow: true, dim: false, extra: next, valueNow: nowPct })),
    h('div', { class: 'col q-eta' }, h('span', { class: 't-sm muted' }, '예상 대기 시간'), h('strong', { class: cx('t-xl', eta && 'num') }, eta ?? '잠시 멈춤')),
    h('p', { class: 'sr-only', 'aria-live': 'polite' }, sentence),
  );
}

/** soon: "곧 입장합니다" + 자동 재시도까지 남은 초. 탭 제목에도 남은 초를 보인다(d5 §5.8) */
function soonBlock(c: EventCtx): HTMLElement {
  const secs = h('span', { class: 'num fw-b' }, '12초');
  const baseTitle = document.title;
  let stop = (): void => undefined;
  let retry: number | undefined;
  let disposed = false;
  const run = (): void => {
    retry = undefined;
    if (disposed) return;
    stop = countdown(Date.now() + 12_000, (sec) => {
      secs.textContent = `${sec}초`;
      document.title = `(${sec}초) 곧 입장 · ${c.ev.title}`;
    }, () => {
      // 목업: 다시 시도해도 SOON이 와서 다시 센다(입장 확정 SOON의 retryAfterSeconds)
      if (!disposed) retry = window.setTimeout(run, 300);
    });
  };
  run();
  c.onCleanup(() => {
    // 정리된 뒤에는 다시 세지 않는다: 기다리던 재시도 타이머를 지우고 진행 중인 카운트다운을 멈춘다
    disposed = true;
    if (retry !== undefined) window.clearTimeout(retry);
    retry = undefined;
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

/** 차례 도래 유예(15분, POL-008): 남은 시간 안에 [지금 입장] → 좌석 화면(SCR-010)으로 전체 이동 */
function graceBlock(c: EventCtx): HTMLElement {
  const remain = h('span', { class: 'num fw-b' }, '14:32');
  c.onCleanup(countdown(Date.now() + (14 * 60 + 32) * 1000, (sec) => {
    remain.textContent = clock(sec);
  }, () => c.go('대기표 만료')));
  return h('div', { class: 'col q-center-block q-g12' },
    h('span', { class: 'state-icon is-primary' }, ic('bell-fill')),
    h('p', { class: 't-2xl', role: 'alert' }, '차례가 되었습니다'),
    h('p', { class: 't-md' }, remain, ' 안에 입장하세요'),
    h('button', { class: 'btn btn-primary btn-lg btn-block q-mt4 q-cta', type: 'button', onclick: () => location.assign(links.seats(c.ev.id)) }, '지금 입장'),
  );
}
