// 화면 목록(`/preview`, 개발 서버에서만 — 운영 빌드 입력에 넣지 않는다). ds PreviewCatalog와 같은 모양을 DOM으로 그린다.
import '@peaket/ds/queue-room.css';
import './styles/page.css';
import '@peaket/ds/queue-room-screens.css';
import './dev/dev.css';
import './styles/preview.css';
import { h } from './dom';
import { DEFAULT_PRODUCT_ID } from './fixtures';

/** 가짜 API 고정 자료의 회차(뮤지컬 별빛 정원) */
const LIVE_EVENT_ID = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e04';
import { GOODS_STATES, stateHref, type BoardState } from './states';

interface Row {
  id: string;
  name: string;
  path: string;
  states: readonly BoardState[];
  note?: string;
}

const ROWS: Row[] = [
  { id: 'SCR-007', name: '로비(오픈 전, 데이터 연결)', path: `/queue/${LIVE_EVENT_ID}`, states: [], note: '가짜 API 상태 queueOpenIn(오픈까지 남은 초)으로 오픈 전 회차를 만든 뒤 연다. 같은 주소가 오픈 전에는 로비, 오픈 뒤에는 대기열, 매진이면 매진 화면을 그린다(§3.4). 참가·셔플은 queueLobby·queueShuffle로 바꾼다(apps/README.md, ADR-0208)' },
  { id: 'SCR-008', name: '대기열(오픈 후, 데이터 연결)', path: `/queue/${LIVE_EVENT_ID}`, states: [], note: '가짜 API(127.0.0.1:4010)에 사전 검증 토큰을 둔 뒤 연다. 상태는 /__mock/state의 queue·queueEntry·queueAdmit로 바꾼다(apps/README.md, ADR-0207)' },
  { id: 'SCR-018', name: '매진(데이터 연결)', path: `/queue/${LIVE_EVENT_ID}`, states: [], note: '가짜 API 상태 queue=sold-out. 운영에서는 엣지 정적 410 응답으로도 열린다' },
  { id: 'SCR-015', name: '굿즈 대기(인기 MD 대기열)', path: `/shop/${DEFAULT_PRODUCT_ID}/queue`, states: GOODS_STATES, note: '굿즈 스토어의 나머지 화면은 소비자 웹(3000)에 있다' },
];

const pathFor = (row: Row, st: BoardState): string => (st.eventId ? `/queue/${st.eventId}` : row.path);

document.getElementById('root')!.append(
  h('main', { class: 'page-main q-catalog', id: 'main' },
    h('header', { class: 'col q-g8' },
      h('h1', { class: 't-xl fw-b' }, '대기실 경량 페이지 화면 목록'),
      h('p', { class: 't-sm muted' },
        '디자인 캔버스를 옮긴 퍼블리싱 화면입니다. 데이터는 목업이고, 상태는 주소의 ', h('code', null, '?state='), '로, 다크는 ', h('code', null, '?theme=dark'), '로 고릅니다(개발 서버에서만 보입니다).',
      ),
      h('nav', { class: 'row wrap', 'aria-label': '다른 앱 화면 목록' },
        h('a', { class: 'chip', href: 'http://localhost:3000/preview' }, '소비자 웹 화면 목록(3000)'),
      ),
    ),
    h('div', { class: 'q-table-wrap' },
      h('table', { class: 'table' },
        h('caption', { class: 'sr-only' }, '대기실 경량 페이지 화면과 상태'),
        h('thead', null, h('tr', null, ['SCR', '화면', '경로', '상태'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, ROWS.map((r) => h('tr', null,
          h('td', { class: 't-sm num' }, r.id),
          h('td', { class: 't-sm fw-b' }, h('a', { href: r.path }, r.name)),
          h('td', { class: 't-xs muted' }, h('code', null, r.path), r.note ? h('div', null, r.note) : null),
          h('td', { class: 't-xs' },
            h('ul', { class: 'row wrap q-g4' }, r.states.map((st) => h('li', null,
              h('a', { href: stateHref(pathFor(r, st), st) }, h('span', { class: 'chip chip-sm' }, st.added ? `${st.name} *` : st.name)),
            ))),
          ),
        ))),
      ),
    ),
    h('p', { class: 't-xs muted' }, '* 보드에 없고 d5 상태 표·docs/frontend.md §3.4에만 있어 더한 상태입니다. 다크는 각 화면 오른쪽 아래 패널에서 바꿉니다.'),
  ),
);
