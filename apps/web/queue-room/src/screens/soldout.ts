// SCR-018 매진. 캔버스 SCR-018 m·t·d 보드(d5 §5.18). 같은 주소(/queue/[eventId])의 매진 상태이고, 운영에서는 엣지 정적 410 응답으로도 열린다.
// 이 화면에서는 대기 상태 폴링을 멈춘다(⑤, 화면에는 안 보임). 처음부터 이 화면을 열면 h1로 초점을 옮긴다(낮음-108).
import { links } from '../config';
import type { EventCtx } from '../ctx';
import { append, h, ic } from '../dom';
import { focusHeader } from './shell';

export function soldOutScreen(c: EventCtx): HTMLElement[] {
  const st = c.state.name;
  const ev = c.ev;
  const closed = st === '판매 종료 뒤 매진';
  const showBtn = st === '매진';
  const subscribed = st === '알림 신청됨';
  const failed = st === '알림 신청 실패';

  const main = h('main', { class: 'page-main q-main q-soldout', id: 'main' });
  const frame = h('div', { class: 'col q-frame q-soldout-frame' });
  main.append(frame);

  append(frame, [
    h('section', { class: 'col q-center-block q-g16', role: 'region', 'aria-label': '대기 상태' },
      h('span', { class: 'state-icon' }, ic('ticket')),
      h('h1', { class: 't-xl', id: 'so-h', tabindex: '-1' }, closed ? '매진되었습니다' : '매진되었습니다. 취소표가 나오면 알려 드릴까요?'),
    ),
    !closed && h('div', { class: 'banner banner-info' }, ic('info'), h('div', { class: 'banner-body' }, ev.tierStatus)),
  ]);

  if (showBtn) {
    frame.append(h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', onclick: () => c.go('알림 신청됨') }, ic('bell'), '취소표 알림 받기'));
  }
  if (subscribed) {
    frame.append(h('div', { class: 'col q-g12 q-ai-center' },
      h('button', { class: 'btn btn-outline btn-lg btn-block', type: 'button', 'aria-pressed': 'true' }, ic('check'), '알림 신청됨'),
      h('a', { class: 'link-more', href: links.likes() }, '관심 공연·알림에서 보기', ic('chevron-right')),
    ));
  }
  if (failed) {
    // CMP-045 inline: 신청 버튼 자리에 다시 시도. 토스트에는 동작 버튼을 두지 않는다(d5 §5.18)
    frame.append(h('div', { class: 'banner banner-danger', role: 'alert' },
      ic('alert-circle'),
      h('div', { class: 'banner-body col q-g8' },
        h('span', null, '알림을 신청하지 못했습니다. 다시 시도해 주세요'),
        h('button', { class: 'btn btn-outline btn-sm q-self-start', type: 'button', onclick: () => c.go('알림 신청됨') }, '다시 시도'),
      ),
    ));
  }

  // ③ 같은 공연 다른 회차(CMP-066 칩 목록) → 그 회차의 공연 상세(SCR-002)
  frame.append(
    h('nav', { class: 'col q-g10 q-ai-center', 'aria-labelledby': 'rd-h' },
      h('h2', { class: 't-sm fw-b', id: 'rd-h' }, '같은 공연 다른 회차'),
      h('ul', { class: 'row wrap q-jc' },
        ev.rounds.map((r) => {
          const current = r.id === ev.currentRound;
          return h('li', null, h('a', { class: current ? 'chip is-selected' : 'chip', href: links.event(ev.id, r.id), 'aria-current': current ? 'page' : null },
            r.label,
            r.status === 'SOLD_OUT' ? h('span', { class: 'badge badge-danger' }, '매진') : h('span', { class: 'badge badge-success' }, '판매 중'),
          ));
        }),
      ),
    ),
    // ④ 공식 굿즈 스토어(SCR-015)
    h('a', { class: 'link-more q-self-center', href: links.shop() }, ic('bag'), '공식 굿즈 스토어', ic('chevron-right')),
  );

  const toast = failed ? h('div', { class: 'toast q-toast', role: 'status' }, ic('alert-circle'), '알림을 신청하지 못했습니다') : null;
  return [focusHeader(c, '닫고 공연 상세로 가기'), main, toast].filter((x): x is HTMLElement => x !== null);
}
