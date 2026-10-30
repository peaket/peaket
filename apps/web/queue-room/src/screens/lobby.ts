// SCR-007 로비(오픈 전 대기실). 캔버스 SCR-007 m·t·d 보드를 한 페이지의 반응형으로 옮겼다(d5 §5.7).
// 휴대폰은 화면 전체, 태블릿은 가운데 520px 열, 데스크톱(lg)은 바탕 위 가운데 480px 카드 하나다(배치는 app.css).
import { KEEP_LOBBY, LEGAL_POL024, LOBBY_PRINCIPLE, ORDERING_TEXT, AUTO_ASSIGN_TEXT, REVEAL_GUIDE } from '../copy';
import { links } from '../config';
import type { EventCtx } from '../ctx';
import { append, cx, h, ic } from '../dom';
import { clock } from '../queue-math';
import { countdown, milestoneAnnouncer } from '../ui/timers';
import { prefFields } from './modals';
import { focusHeader, offlineStrip } from './shell';

export function lobbyScreen(c: EventCtx): HTMLElement[] {
  const st = c.state.name;
  const ev = c.ev;
  const auto = ev.autoAssign;
  const other = st === '다른 기기 참가 409';
  const reveal = st === '순번 공개 대기';
  const delayed = st === '발표 지연';
  const hcLoading = st === '사람 확인 중';
  const hcFail = st === '사람 확인 실패';
  const calc = st === '순서 계산 중';
  const emerg = st === '비상 처리 공지';
  const canceled = st === '다른 기기에서 취소됨';
  const offline = st === '오프라인';
  const notYet = st === '참가 전, 이 기기의 버튼은 아직';
  const afterOpen = reveal || delayed || calc || emerg;
  const isJoined = !other && !hcLoading && !hcFail && !notYet;
  const showNotice = ev.notice !== null && !emerg;

  const main = h('main', { class: 'page-main q-main q-lobby', id: 'main' });
  const frame = h('div', { class: 'col q-frame q-lobby-frame' }, h('h1', { class: 'sr-only', tabindex: '-1' }, '오픈 전 대기실(로비)'));
  main.append(frame);

  if (canceled) {
    frame.append(
      h('section', { class: 'state q-state-page', role: 'alert' },
        h('span', { class: 'state-icon' }, ic('device')),
        h('h2', { class: 't-lg' }, '다른 기기에서 이 참가를 취소했습니다'),
        h('a', { class: 'btn btn-outline btn-lg btn-block q-mt8 q-cta', href: links.event(ev.id) }, '공연 상세', ic('chevron-right')),
      ),
    );
    return [focusHeader(c), main];
  }

  // ① 카운트다운(이정표형 낭독) 또는 오픈 뒤 자리
  if (!afterOpen) frame.append(countdownSection(c));
  if (reveal || emerg) frame.append(waitSection('곧 순번이 공개됩니다'));
  if (calc) frame.append(waitSection('순서 계산 중입니다'));
  if (delayed) {
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
        auto && h('p', { class: 'fw-b' }, AUTO_ASSIGN_TEXT),
      ),
    ),
    // ⑨ 순번 공개 안내(숫자 없이)
    h('p', { class: 'row t-sm q-guide' }, ic('history', 'ic-16 muted'), h('span', null, REVEAL_GUIDE)),
  );

  // ② 사람 확인(CMP-047). 실제 위젯(Turnstile)은 데이터 연결 단계에서 이 카드 안에 싣는다
  if (isJoined) {
    frame.append(
      h('section', { class: 'card row q-hc', 'aria-labelledby': 'hc-h' },
        ic('shield', 'tx-success'),
        h('h2', { class: 't-md fw-b grow', id: 'hc-h' }, '사람 확인'),
        h('span', { class: 'badge badge-success' }, ic('check'), '확인 완료'),
      ),
    );
  }
  if (notYet) frame.append(notYetCard(c));
  if (hcLoading) {
    frame.append(
      h('section', { class: 'card col q-hc q-g12', 'aria-labelledby': 'hc-h2' },
        h('div', { class: 'row q-g10' }, ic('shield', 'muted'), h('h2', { class: 't-md fw-b grow', id: 'hc-h2' }, '사람 확인')),
        h('div', { class: 'progress indet', role: 'progressbar', 'aria-label': '사람 확인 중' }, h('span')),
      ),
    );
  }
  if (hcFail) {
    frame.append(
      h('section', { class: 'card col q-hc q-g12', 'aria-labelledby': 'hc-h3' },
        h('div', { class: 'row q-g10' }, ic('shield', 'muted'), h('h2', { class: 't-md fw-b grow', id: 'hc-h3' }, '사람 확인')),
        h('div', { class: 'banner banner-danger', role: 'alert' },
          ic('alert-circle'),
          h('div', { class: 'banner-body col q-g8' },
            h('span', null, '확인하지 못했습니다. 다시 시도해 주세요'),
            h('button', { class: 'btn btn-outline btn-sm q-self-start', type: 'button', onclick: () => c.go('사람 확인 중') }, '다시 시도'),
          ),
        ),
      ),
    );
  }

  if (other) {
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

  // ⑧ 희망 조건(CMP-057 preference, 자동 배정 공연만). 이 기기에만 저장된다
  if (auto) {
    frame.append(
      h('section', { class: 'card col q-pref', 'aria-labelledby': 'pf-h' },
        h('div', { class: 'row between' },
          h('h2', { class: 't-md fw-b', id: 'pf-h' }, '희망 조건'),
          h('span', { class: 'badge badge-success', role: 'status' }, ic('check'), '저장됨'),
        ),
        prefFields(ev, 'lobby'),
        h('p', { class: 'hint' }, '차례 전까지 바꿀 수 있고 이 기기에만 저장됩니다'),
      ),
    );
  }

  // ④ 법정 고지(POL-024 라목) · ⑤ 운영 공지 · 비상 처리 공지
  append(frame, [
    h('div', { class: 'banner banner-legal' }, ic('scale'), h('div', { class: 'banner-body' }, h('span', { class: 'legal-tag' }, '법정 고지'), LEGAL_POL024)),
    showNotice && h('div', { class: 'banner banner-announce', role: 'status' },
      ic('megaphone'),
      h('div', { class: 'banner-body' }, h('span', { class: 'banner-title' }, '운영 공지'), ev.notice ?? ''),
    ),
    emerg && h('div', { class: 'banner banner-announce', role: 'status' },
      ic('megaphone'),
      h('div', { class: 'banner-body col q-g6' },
        h('span', null, '비상 절차로 순서를 정했습니다'),
        h('a', { class: 'link-more q-self-start', href: links.shuffleProof(ev.id) }, '셔플 검증', ic('chevron-right')),
      ),
    ),
  ]);

  // ⑦ 시드 해시 · 셔플 검증(SCR-019)
  const copyStatus = h('span', { class: 'sr-only', role: 'status' });
  frame.append(
    h('div', { class: 'row wrap q-seed' },
      h('span', { class: 't-sm muted' }, '시드 해시'),
      h('span', { class: 'hash' }, ev.seedHash),
      h('button', {
        class: 'btn btn-text',
        type: 'button',
        'aria-label': '시드 해시 복사',
        onclick: () => {
          void navigator.clipboard?.writeText(ev.seedHash).then(() => {
            copyStatus.textContent = '시드 해시를 복사했습니다';
          }, () => undefined);
        },
      }, ic('copy', 'ic-16'), '복사'),
      h('a', { class: 'link-more', href: links.shuffleProof(ev.id) }, '셔플 검증', ic('chevron-right')),
      copyStatus,
    ),
  );

  // ⑩ 차례 알림 받기(CMP-068) · "창을 닫아도 참가는 유지됩니다"(참가 토큰을 받은 뒤에만)
  const notify = h('button', {
    class: 'btn btn-secondary btn-lg btn-block q-cta',
    type: 'button',
    'aria-haspopup': 'dialog',
    onclick: () => c.open('notify', notify),
  }, ic('bell'), '차례 알림 받기');
  frame.append(h('div', { class: 'col q-lobby-cta' }, notify, !notYet && h('p', { class: 't-sm muted q-center' }, KEEP_LOBBY)));

  return [offline ? offlineStrip(`인터넷 연결이 없습니다 · 마지막 동기화 ${ev.lastSync} · 카운트다운은 이 기기 시계로 계속합니다`) : null, focusHeader(c), main]
    .filter((x): x is HTMLElement => x !== null);
}

/** ① 오픈까지 카운트다운(CMP-014 large). role="timer"는 바뀔 때마다 읽지 않고, 따로 둔 live 영역이 5분·1분·10초에만 읽는다 */
function countdownSection(c: EventCtx): HTMLElement {
  const timer = h('p', { class: 't-display q-timer', role: 'timer', 'aria-labelledby': 'cd-l' }, clock(c.ev.secondsToOpen));
  const live = h('p', { class: 'sr-only', 'aria-live': 'polite' });
  const say = milestoneAnnouncer(live, '오픈까지');
  // 목업 시계: 페이지를 연 때부터 고정된 남은 시간으로 센다. 0이 되면 시연대로 '순번 공개 대기'로 넘어간다(d5 §5.7 시연 흉내)
  const stop = countdown(Date.now() + c.ev.secondsToOpen * 1000, (sec) => {
    timer.textContent = clock(sec);
    say(sec);
  }, () => c.go('순번 공개 대기'));
  c.onCleanup(stop);
  return h('section', { class: 'col q-hero q-cd', 'aria-labelledby': 'cd-l' },
    h('p', { class: 't-md fw-b muted', id: 'cd-l' }, '오픈까지'),
    timer,
    h('p', { class: 't-sm muted' }, `${c.ev.openAt} 오픈`),
    live,
  );
}

function waitSection(text: string): HTMLElement {
  return h('section', { class: 'col q-hero q-hero-wait', role: 'region', 'aria-label': '대기 상태' },
    h('span', { class: 'spinner tx-link q-spin-lg', 'aria-hidden': 'true' }),
    h('p', { class: 't-xl', role: 'status' }, text),
  );
}

/** 참가 전, 이 기기의 로비 버튼이 열리기까지 남은 초(d5 §5.7, 소유자 결정 2026-10-30). 0이 되면 사람 확인을 시작한다 */
function notYetCard(c: EventCtx): HTMLElement {
  const remain = h('span', { class: 'num' }, clock(c.ev.joinOpensIn, false));
  const live = h('p', { class: 'sr-only', 'aria-live': 'polite' });
  const stop = countdown(Date.now() + c.ev.joinOpensIn * 1000, (sec) => {
    remain.textContent = clock(sec, false);
  }, () => c.go('사람 확인 중'));
  c.onCleanup(stop);
  return h('section', { class: cx('card col q-hc q-g6'), 'aria-labelledby': 'ny-h', 'aria-describedby': 'ny-d' },
    h('div', { class: 'row q-g10' },
      ic('clock', 'muted'),
      h('h2', { class: 't-md fw-b grow', id: 'ny-h' }, '곧 들어갈 수 있습니다', h('span', { 'aria-hidden': 'true' }, ' · ', remain)),
    ),
    h('p', { class: 't-sm muted q-indent', id: 'ny-d' }, '로비 안에서는 언제 들어와도 순번이 같습니다'),
    live,
  );
}
