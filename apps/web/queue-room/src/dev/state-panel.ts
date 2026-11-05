// 퍼블리싱 상태 고르기 패널(개발 서버에서만, import.meta.env.DEV). ds의 StateSwitcher(React)와 같은 모양을 DOM으로 그린다.
// 운영 빌드에는 들어가지 않는다(main.ts가 DEV일 때만 동적으로 불러온다).
import './dev.css';
import { h } from '../dom';
import type { Route } from '../route';
import { GOODS_STATES, LOBBY_STATES, stateHref, type BoardState } from '../states';

// 휴대폰 폭에서는 화면을 가리지 않게 접은 채로 시작한다
let open = window.matchMedia('(min-width: 768px)').matches;

export function mountStatePanel(o: { route: Route; current: BoardState; dark: boolean }): void {
  document.getElementById('q-dev')?.remove();
  const groups: [string, readonly BoardState[]][] = o.route.kind === 'goods'
    ? [['SCR-015 굿즈 대기', GOODS_STATES]]
    : [['SCR-007 로비(퍼블리싱, HOT-341)', LOBBY_STATES]];
  const theme = o.dark ? 'dark' : undefined;
  const pathFor = (st: BoardState): string => (o.route.kind === 'event' && st.eventId ? `/queue/${st.eventId}` : location.pathname);

  const list = h('div', { class: 'col q-dev-list' },
    groups.map(([title, states]) => h('section', { class: 'col' },
      h('h2', { class: 't-xs fw-b muted q-dev-h' }, title),
      h('ul', { class: 'col' },
        states.map((st) => h('li', null, h('a', {
          class: 't-xs',
          href: stateHref(pathFor(st), st, { theme }),
          'aria-current': st.name === o.current.name ? 'true' : null,
        }, st.name === o.current.name ? h('strong', null, `● ${st.name}`) : st.name, st.added ? ' (d5에서 더함)' : ''))),
      ),
    )),
    h('a', { class: 't-xs q-dev-theme', href: stateHref(location.pathname, o.current, { theme: o.dark ? undefined : 'dark' }) }, o.dark ? '라이트로 보기' : '다크로 보기'),
    h('a', { class: 't-xs', href: '/preview' }, '화면 목록(/preview)'),
  );
  list.hidden = !open;
  const toggle = h('button', {
    class: 'btn btn-ghost btn-sm q-dev-toggle',
    type: 'button',
    'aria-expanded': String(open),
    onclick: () => {
      open = !open;
      list.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
    },
  }, h('span', { class: 't-xs fw-b' }, '상태 · 개발용'), h('span', { class: 't-xs muted' }, o.current.name));
  document.body.append(h('aside', { id: 'q-dev', class: 'q-dev', 'aria-label': '퍼블리싱 상태 고르기' }, h('div', { class: 'card q-dev-card' }, toggle, list)));
}
