// SCR-018 매진. 캔버스 SCR-018 m·t·d 보드(d5 §5.18). 같은 주소(/queue/[eventId])의 매진 상태이고, 운영에서는 엣지 정적 410 응답으로도 열린다.
// 이 화면에서는 대기 상태 폴링을 멈춘다(⑤, 화면에는 안 보임). 처음부터 이 화면을 열면 h1로 초점을 옮긴다(낮음-108).
import { links } from '../config';
import type { EventCtx, LiveCtx } from '../ctx';
import type { CancelAlertResult } from '../live/cancel-alert.ts';
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

/**
 * 매진(데이터 연결, ADR-0207). 대기 상태 파일·입장 확정이 매진이면 폴링을 멈추고 이 화면을 그린다. 다른 회차는 공연 공개 요약의 회차 목록이다(회차마다 자기 공연 상세).
 * [취소표 알림 받기](ADR-0213 결정 5, d5 §5.18): 처음 그릴 때 신청 상태를 보고, 누르면 한 번 보낸다. 신청됨 → '알림 신청됨' + ( 관심 공연·알림에서 보기 › ),
 * 판매 종료(410·판매 종료로 끝난 신청) → 버튼을 숨김, 한도(422) → 정리 안내, 실패 → 토스트(동작 없음) + 버튼 자리의 [다시 시도], 401 → 로그인
 */
export function liveSoldOutScreen(c: LiveCtx): HTMLElement[] {
  const ev = c.ev;
  const api = c.cancelAlert;
  const main = h('main', { class: 'page-main q-main q-soldout', id: 'main' });
  const frame = h('div', { class: 'col q-frame q-soldout-frame' });
  main.append(frame);
  const title = h('h1', { class: 't-xl', id: 'so-h', tabindex: '-1' }, '매진되었습니다. 취소표가 나오면 알려 드릴까요?');
  // 버튼 자리. 결과마다 이 안을 바꾸고, 바뀐 것은 늘 있는 낭독 영역 하나가 알린다(새로 붙인 낭독 영역은 읽히지 않을 수 있다)
  const slot = h('div', { class: 'col q-g12 q-ai-center' });
  const said = h('p', { class: 'sr-only', role: 'status' });
  // 토스트는 보이는 알림이다. 같은 문장은 위 낭독 영역이 읽으므로 낭독기에는 숨긴다(두 번 읽지 않게)
  const toast = h('div', { class: 'toast q-toast', 'aria-hidden': 'true', hidden: true }, ic('alert-circle'), '알림을 신청하지 못했습니다');
  let toastTimer = 0;
  let sayTimer = 0;
  c.onCleanup(() => {
    window.clearTimeout(toastTimer);
    window.cancelAnimationFrame(sayTimer);
  });
  // 누른 뒤에는 늦게 온 신청 상태 답으로 화면을 바꾸지 않는다
  let pressed = false;

  const say = (message: string): void => {
    // 같은 문장을 다시 알릴 때도 읽히게 비웠다가 다음 그리기에서 넣는다
    said.textContent = '';
    window.cancelAnimationFrame(sayTimer);
    if (message) sayTimer = window.requestAnimationFrame(() => (said.textContent = message));
  };
  const put = (node: HTMLElement, focus: HTMLElement | null, message: string): void => {
    slot.replaceChildren(node);
    say(message);
    focus?.focus();
  };
  const subscribed = (focus: boolean): void => {
    // 신청됨은 누를 것이 없는 표시다(대기실에서는 끄지 않는다, SCR-054가 끈다). 초점은 관심 공연·알림 링크로
    const done = h('p', { class: 'btn btn-outline btn-lg btn-block q-btn-static' }, ic('check'), '알림 신청됨');
    const more = h('a', { class: 'link-more', href: links.likes() }, '관심 공연·알림에서 보기', ic('chevron-right'));
    put(h('div', { class: 'col q-g12 q-ai-center q-w-full' }, done, more), focus ? more : null, focus ? '취소표 알림을 신청했습니다' : '');
  };
  const closed = (focus: boolean): void => {
    // 판매가 끝나면 버튼을 숨기고 다른 회차만 보인다(d5 §5.18)
    title.textContent = '매진되었습니다';
    const p = h('p', { class: 't-sm muted q-center', tabindex: '-1' }, '판매가 끝나 알림을 신청할 수 없습니다');
    put(p, focus ? p : null, focus ? '판매가 끝나 알림을 신청할 수 없습니다' : '');
  };
  const button = (label: string, describedBy?: string): HTMLButtonElement => {
    const b = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', 'aria-describedby': describedBy ?? null }, ic('bell'), label);
    b.addEventListener('click', () => void press(b));
    return b;
  };
  const busy = (b: HTMLElement): void => {
    b.setAttribute('aria-busy', 'true');
    b.setAttribute('aria-disabled', 'true');
  };
  async function press(b: HTMLButtonElement): Promise<void> {
    if (b.getAttribute('aria-busy') === 'true') return;
    pressed = true;
    busy(b);
    show(await api.subscribe(), b);
  }
  function show(r: CancelAlertResult, b: HTMLElement): void {
    if (r === 'login') return c.navigate(links.login(c.path));
    // 다시 그린 화면은 페이지에 하나인 상태(known)로 신청됨·닫힘을 이어받는다
    if (!b.isConnected) return;
    toast.hidden = true;
    if (r === 'subscribed') return subscribed(true);
    if (r === 'closed') return closed(true);
    if (r === 'limit') {
      const more = h('a', { class: 'link-more', href: links.likes() }, '관심 공연·알림', ic('chevron-right'));
      const text = '신청한 알림이 너무 많아 더 신청할 수 없습니다. 관심 공연·알림에서 정리해 주세요';
      return put(h('div', { class: 'banner banner-warning' }, ic('alert'), h('div', { class: 'banner-body col q-g8' }, h('span', null, text), more)), more, text);
    }
    // 실패: 토스트(동작 버튼 없음)와 버튼 자리의 [다시 시도](CMP-045 inline). [다시 시도]에 까닭 글을 잇는다
    toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toast.hidden = true), 4000);
    const text = '알림을 신청하지 못했습니다. 다시 시도해 주세요';
    const again = button('다시 시도', 'so-fail');
    put(h('div', { class: 'banner banner-danger col q-g8' }, h('span', { class: 'row q-g8', id: 'so-fail' }, ic('alert-circle'), text), again), again, text);
  }

  const k = api.known();
  if (k === 'subscribed') subscribed(false);
  else if (k === 'closed') closed(false);
  else {
    const b = button('취소표 알림 받기');
    slot.append(b);
    // 다시 그리기 전에 누른 신청이 아직 가는 중이면 그 결과를 기다린다
    const p = api.pending();
    if (p) {
      pressed = true;
      busy(b);
      void p.then((r) => show(r, b));
    } else if (k === null) {
      // 이미 신청했는지(다른 탭·기기에서). 누르기 전에 답이 오면 그 상태로 바꾼다
      void api.status().then((s) => {
        if (pressed || !slot.isConnected) return;
        if (s === 'subscribed') subscribed(false);
        else if (s === 'closed') closed(false);
      });
    }
  }

  frame.append(
    h('section', { class: 'col q-center-block q-g16', role: 'region', 'aria-label': '대기 상태' },
      h('span', { class: 'state-icon' }, ic('ticket')),
      title,
    ),
    slot,
    said,
  );
  const others = ev.rounds.filter((r) => r.id !== ev.id);
  if (others.length > 0) {
    frame.append(h('nav', { class: 'col q-g10 q-ai-center', 'aria-labelledby': 'rd-h' },
      h('h2', { class: 't-sm fw-b', id: 'rd-h' }, '같은 공연 다른 회차'),
      h('ul', { class: 'row wrap q-jc' },
        // 공개 요약의 회차 상태는 공연 상태(SCHEDULED·POSTPONED)라 판매 배지는 달지 않는다(취소 회차는 뺐다)
        others.map((r) => h('li', null, h('a', { class: 'chip', href: links.event(r.id) }, r.label))),
      ),
    ));
  }
  frame.append(h('a', { class: 'link-more q-self-center', href: links.shop() }, ic('bag'), '공식 굿즈 스토어', ic('chevron-right')));
  return [focusHeader(c, '닫고 공연 상세로 가기'), main, toast];
}
