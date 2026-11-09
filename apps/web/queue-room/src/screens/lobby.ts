// SCR-007 로비(오픈 전 대기실). 캔버스 SCR-007 m·t·d 보드를 한 페이지의 반응형으로 옮겼다(d5 §5.7).
// 휴대폰은 화면 전체, 태블릿은 가운데 520px 열, 데스크톱(lg)은 바탕 위 가운데 480px 카드 하나다(배치는 @peaket/ds/queue-room-screens.css).
// 화면 값은 상태 기계(src/live/controller.ts)가 낸다(ADR-0208): lobby-join(not-yet·checking·failed), lobby(countdown·reveal·calculating·delayed),
// 로비 참가의 다른 기기·다른 기기에서 취소됨, ⑧ 희망 조건(자동 배정 공연)과 ⑩ [차례 알림 받기](ADR-0212). ⑤ 운영 공지는 OPS-410이 잇는다(ADR-0208 결정 8).
import { KEEP_LOBBY, LEGAL_POL024, LOBBY_PRINCIPLE, ORDERING_TEXT, AUTO_ASSIGN_TEXT, REVEAL_GUIDE } from '../copy';
import { links } from '../config';
import type { LiveCtx } from '../ctx';
import { cx, h, ic } from '../dom';
import { clock } from '../queue-math';
import { countdown, milestoneAnnouncer } from '../ui/timers';
import { steadyNow } from '../live/steady.ts';
import { focusHeader, offlineStrip } from './shell';
import { prefEditor } from './preference';
import { defaultPreference } from '../live/preference.ts';

const hhmm = (ms: number): string => {
  const d = new Date(ms + 9 * 3600_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

/** 이 화면이 그리는 상태인지(그 밖은 대기열 화면) */
export function isLobbyView(v: LiveCtx['view']): boolean {
  return v.state === 'lobby-join' || v.state === 'lobby' || ((v.state === 'other-device' || v.state === 'cancelled-elsewhere') && v.via === 'lobby');
}

export function lobbyScreen(c: LiveCtx): HTMLElement[] {
  const v = c.view;
  const ev = c.ev;
  const joined = v.state === 'lobby';
  const phase = v.phase;
  const afterOpen = joined && phase !== 'countdown';

  const main = h('main', { class: 'page-main q-main q-lobby', id: 'main' });
  const frame = h('div', { class: 'col q-frame q-lobby-frame' }, h('h1', { class: 'sr-only', tabindex: '-1' }, '오픈 전 대기실(로비)'));
  main.append(frame);

  if (v.state === 'cancelled-elsewhere') {
    frame.append(
      h('section', { class: 'state q-state-page', role: 'alert' },
        h('span', { class: 'state-icon' }, ic('device')),
        h('h2', { class: 't-lg', tabindex: '-1' }, '다른 기기에서 이 참가를 취소했습니다'),
        h('a', { class: 'btn btn-outline btn-lg btn-block q-mt8 q-cta', href: links.event(ev.id) }, '공연 상세', ic('chevron-right')),
      ),
    );
    return [focusHeader(c), main];
  }

  // ① 카운트다운(이정표형 낭독) 또는 오픈 뒤 자리. 참가 전에도 오픈까지의 시간은 보인다(오픈 시각을 받았을 때)
  if (!afterOpen) frame.append(countdownSection(c));
  if (phase === 'reveal') frame.append(waitSection('곧 순번이 공개됩니다'));
  if (phase === 'calculating') frame.append(waitSection('순서 계산 중입니다'));
  if (phase === 'delayed') {
    frame.append(
      h('section', { class: 'col q-hero q-hero-delayed', role: 'region', 'aria-label': '대기 상태' },
        h('span', { class: 'state-icon is-warning' }, ic('clock')),
        h('div', { class: 'col q-g8', role: 'status' },
          h('p', { class: 't-xl' }, '순서 발표가 늦어지고 있습니다.'),
          h('p', { class: 't-md' }, '참가는 그대로 유지되고, 발표되면 자동으로 이어집니다'),
        ),
      ),
    );
  }

  // ③ 정렬 방식(POL-004)
  const ord = ORDERING_TEXT[ev.ordering];
  frame.append(
    h('div', { class: 'banner banner-info' },
      ic('info'),
      h('div', { class: 'banner-body col q-g8' },
        !afterOpen && h('p', { class: 't-md fw-b' }, LOBBY_PRINCIPLE),
        h('span', { class: 'badge badge-primary q-self-start' }, ord.badge),
        ord.body.map((t) => h('p', null, t)),
        ev.autoAssign && h('p', { class: 'fw-b' }, AUTO_ASSIGN_TEXT),
      ),
    ),
    // ⑨ 순번 공개 안내(숫자 없이)
    h('p', { class: 'row t-sm q-guide' }, ic('history', 'ic-16 muted'), h('span', null, REVEAL_GUIDE)),
  );

  // ② 사람 확인(CMP-047). 통과하면 접혀서 "확인 완료"
  if (joined) {
    frame.append(
      h('section', { class: 'card row q-hc', 'aria-labelledby': 'hc-h' },
        ic('shield', 'tx-success'),
        h('h2', { class: 't-md fw-b grow', id: 'hc-h' }, '사람 확인'),
        h('span', { class: 'badge badge-success' }, ic('check'), '확인 완료'),
      ),
    );
  }
  if (v.state === 'lobby-join' && phase === 'not-yet') frame.append(notYetCard(c, v.joinAt ?? steadyNow()));
  if (v.state === 'lobby-join' && phase === 'checking') {
    // 위젯은 이 자리(#hc-slot)에 늦게 싣는다(src/live/human-check.ts). 진행 막대의 읽히는 이름만 둔다(보이는 글은 더하지 않는다)
    frame.append(
      h('section', { class: 'card col q-hc q-g12', 'aria-labelledby': 'hc-h2' },
        h('div', { class: 'row q-g10' }, ic('shield', 'muted'), h('h2', { class: 't-md fw-b grow', id: 'hc-h2' }, '사람 확인')),
        h('div', { class: 'progress indet', role: 'progressbar', 'aria-label': '사람 확인 중' }, h('span')),
        h('div', { id: 'hc-slot', class: 'q-hc-slot' }),
      ),
    );
  }
  if (v.state === 'lobby-join' && phase === 'failed') {
    frame.append(
      h('section', { class: 'card col q-hc q-g12', 'aria-labelledby': 'hc-h3' },
        h('div', { class: 'row q-g10' }, ic('shield', 'muted'), h('h2', { class: 't-md fw-b grow', id: 'hc-h3', tabindex: '-1' }, '사람 확인')),
        h('div', { class: 'banner banner-danger', role: 'alert' },
          ic('alert-circle'),
          h('div', { class: 'banner-body col q-g8' },
            h('span', null, '확인하지 못했습니다. 다시 시도해 주세요'),
            h('button', { class: 'btn btn-outline btn-sm q-self-start', type: 'button', onclick: () => c.actions.retry() }, '다시 시도'),
          ),
        ),
      ),
    );
  }

  if (v.state === 'other-device') {
    const rejoin = h('button', {
      class: 'btn btn-text q-btn-flush q-self-start',
      type: 'button',
      'aria-haspopup': 'dialog',
      'data-opens': 'rejoin',
      onclick: () => c.open('rejoin', rejoin),
    }, '이 기기에서 다시 참가', ic('chevron-right'));
    frame.append(
      h('div', { class: 'banner banner-warning', role: 'alert' },
        ic('device'),
        h('div', { class: 'banner-body col q-g6' },
          h('p', null, '이미 다른 기기나 탭에서 로비에 들어와 있습니다. 처음 들어온 곳에서 계속하세요'),
          rejoin,
        ),
      ),
    );
  }

  // ⑧ 희망 조건(CMP-057 preference, 자동 배정 공연만). 바꿀 때마다 이 기기에 저장한다(ADR-0212 결정 1)
  if (c.pref) frame.append(prefCard(c));

  // ④ 법정 고지(POL-024 라목)
  frame.append(h('div', { class: 'banner banner-legal' }, ic('scale'), h('div', { class: 'banner-body' }, h('span', { class: 'legal-tag' }, '법정 고지'), LEGAL_POL024)));

  // ⑦ 시드 해시 · 셔플 검증(SCR-019). 참가 토큰 응답의 공시 값이라 참가한 뒤에만 보인다
  if (joined && v.seedHash) {
    const seed = v.seedHash;
    const copyStatus = h('span', { class: 'sr-only', role: 'status' });
    frame.append(
      h('div', { class: 'row wrap q-seed' },
        h('span', { class: 't-sm muted' }, '시드 해시'),
        h('span', { class: 'hash', title: seed }, `${seed.slice(0, 4)}…${seed.slice(-4)}`),
        h('button', {
          class: 'btn btn-text',
          type: 'button',
          'aria-label': '시드 해시 복사',
          onclick: () => {
            void navigator.clipboard?.writeText(seed).then(() => {
              copyStatus.textContent = '시드 해시를 복사했습니다';
            }, () => undefined);
          },
        }, ic('copy', 'ic-16'), '복사'),
        h('a', { class: 'link-more', href: links.shuffleProof(ev.id) }, '셔플 검증', ic('chevron-right')),
        copyStatus,
      ),
    );
  }

  // ⑩ [차례 알림 받기](CMP-068) · "창을 닫아도 참가는 유지됩니다"(참가 토큰을 받은 뒤에만)
  const notify = h('button', { class: 'btn btn-secondary btn-lg btn-block q-cta', type: 'button', 'aria-haspopup': 'dialog', 'data-opens': 'notify' }, ic('bell'), '차례 알림 받기');
  notify.addEventListener('click', () => c.open('notify', notify));
  frame.append(h('div', { class: 'col q-lobby-cta' }, notify, joined && h('p', { class: 't-sm muted q-center' }, KEEP_LOBBY)));

  const offline = v.offline
    ? offlineStrip(`인터넷 연결이 없습니다${v.lastSyncAt !== undefined ? ` · 마지막 동기화 ${hhmm(v.lastSyncAt)}` : ''} · 카운트다운은 이 기기 시계로 계속합니다`)
    : null;
  return [offline, focusHeader(c), main].filter((x): x is HTMLElement => x !== null);
}

/** ① 오픈까지 카운트다운(CMP-014 large). role="timer"는 바뀔 때마다 읽지 않고, 따로 둔 live 영역이 5분·1분·10초에만 읽는다 */
function countdownSection(c: LiveCtx): HTMLElement {
  const openAt = c.view.openAt;
  const timer = h('p', { class: 't-display q-timer num', role: 'timer', 'aria-labelledby': 'cd-l' }, openAt === undefined ? '--:--' : clock((openAt - steadyNow()) / 1000));
  const live = h('p', { class: 'sr-only', 'aria-live': 'polite' });
  if (openAt !== undefined) {
    const say = milestoneAnnouncer(live, '오픈까지');
    c.onCleanup(countdown(openAt, (sec) => {
      timer.textContent = clock(sec);
      say(sec);
    }));
  }
  return h('section', { class: 'col q-hero q-cd', 'aria-labelledby': 'cd-l' },
    h('p', { class: 't-md fw-b muted', id: 'cd-l' }, '오픈까지'),
    timer,
    c.ev.openLabel && h('p', { class: 't-sm muted' }, `${c.ev.openLabel} 오픈`),
    live,
  );
}

function waitSection(text: string): HTMLElement {
  return h('section', { class: 'col q-hero q-hero-wait', role: 'region', 'aria-label': '대기 상태' },
    h('span', { class: 'spinner tx-link q-spin-lg', 'aria-hidden': 'true' }),
    h('p', { class: 't-xl', role: 'status' }, text),
  );
}

/** 참가 전, 이 기기의 로비 버튼이 열리기까지 남은 초(d5 §5.7, 소유자 결정 2026-10-30). 0이 되면 상태 기계가 사람 확인을 시작한다 */
function notYetCard(c: LiveCtx, joinAt: number): HTMLElement {
  const remain = h('span', { class: 'num' }, clock(Math.ceil((joinAt - steadyNow()) / 1000), false));
  c.onCleanup(countdown(joinAt, (sec) => {
    remain.textContent = clock(sec, false);
  }));
  return h('section', { class: cx('card col q-hc q-g6'), 'aria-labelledby': 'ny-h', 'aria-describedby': 'ny-d' },
    h('div', { class: 'row q-g10' },
      ic('clock', 'muted'),
      h('h2', { class: 't-md fw-b grow', id: 'ny-h' }, '곧 들어갈 수 있습니다', h('span', { 'aria-hidden': 'true' }, ' · ', remain)),
    ),
    h('p', { class: 't-sm muted q-indent', id: 'ny-d' }, '로비 안에서는 언제 들어와도 순번이 같습니다'),
  );
}

/** ⑧ 희망 조건 카드: 처음에는 기본값이고, 바꾸면 바로 저장해 '저장됨'을 보인다 */
function prefCard(c: LiveCtx): HTMLElement {
  const pref = c.pref!;
  const stored = pref.read();
  const badge = h('span', { class: 'badge badge-success', role: 'status', hidden: stored === null }, ic('check'), '저장됨');
  const err = h('p', { class: 't-sm tx-danger', role: 'alert', hidden: true }, '이 브라우저에 저장하지 못했습니다');
  return h('section', { class: 'card col q-pref', 'aria-labelledby': 'pf-h' },
    h('div', { class: 'row between' }, h('h2', { class: 't-md fw-b', id: 'pf-h' }, '희망 조건'), badge),
    prefEditor({
      idp: 'pfl',
      tiers: pref.tiers,
      max: pref.max,
      value: stored ?? defaultPreference(pref.tiers),
      onChange: (p) => {
        const ok = pref.save(p);
        err.hidden = ok;
        // 바꿀 때마다 '저장됨'을 다시 읽게 비웠다가 넣는다(CMP-057 '텍스트로 함께 알림')
        badge.hidden = true;
        if (ok) requestAnimationFrame(() => (badge.hidden = false));
      },
    }),
    err,
    h('p', { class: 'hint' }, '차례 전까지 바꿀 수 있고 이 기기에만 저장됩니다'),
  );
}
