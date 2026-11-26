// SCR-062 라이브 화면의 순수 렌더(TR-03). 훅·fetch 없이 상태를 받아 글자·요소만 그린다.
// `LivePartnerHome.tsx`가 API 결과를 이 뷰에 넘긴다. 값은 React 글자 노드로만 넣는다.
import { createElement, type ReactNode } from 'react';
import type { HomeRow, TodoCard } from '../model/live';

export type HomeViewMode = 'loading' | 'error' | 'empty' | 'ready';

export interface HomeLiveViewProps {
  mode: HomeViewMode;
  rows?: HomeRow[];
  /** null이면 할 일 API만 실패한 부분 성공이다. */
  todo?: TodoCard[] | null;
  message?: string | null;
}

const h = createElement;

export function HomeLiveView({ mode, rows = [], todo, message = null }: HomeLiveViewProps): ReactNode {
  return h(
    'div',
    { className: 'col gap-6' },
    h('h1', null, '공연 관리'),
    todo === null
      ? h('p', { className: 'banner banner-warning', role: 'status' }, '할 일을 불러오지 못했습니다. 공연 목록은 그대로 봅니다.')
      : todo === undefined
        ? null
        : TodoCards({ cards: todo }),
    mode === 'loading' ? h('p', { role: 'status' }, '공연 목록을 불러오고 있습니다') : null,
    mode === 'error'
      ? h(
          'section',
          { className: 'card state', role: 'alert' },
          h('h2', { className: 't-lg' }, '공연 목록을 불러오지 못했습니다'),
          message ? h('p', { className: 't-sm' }, message) : null,
          h('a', { className: 'btn btn-outline', href: '/events' }, '다시 시도'),
        )
      : null,
    mode === 'empty'
      ? h(
          'section',
          { className: 'card state' },
          h('h2', { className: 't-lg' }, '등록한 공연이 없습니다'),
          h('p', { className: 't-sm muted' }, '공연을 등록하고 판매 승인을 요청하면 이곳에서 승인 상태와 판매 상태를 봅니다.'),
          h('a', { className: 'btn btn-primary', href: '/events/new' }, '새 공연 등록'),
        )
      : null,
    mode === 'ready' ? List({ rows }) : null,
  );
}

function TodoCards({ cards }: { cards: TodoCard[] }): ReactNode {
  return h(
    'section',
    { className: 'col gap-3', 'aria-labelledby': 'h-todo' },
    h('h2', { className: 't-md fw-b', id: 'h-todo' }, '할 일'),
    h(
      'div',
      { className: 'grid grid-cols-2 gap-3 lg:grid-cols-4' },
      cards.map((c) =>
        h(
          'div',
          { className: 'stat', key: c.label },
          h('span', { className: 'stat-label' }, c.label),
          h('span', { className: 'stat-value' }, c.value),
          c.meta ? h('span', { className: 'stat-meta' }, c.meta) : null,
          c.href ? h('a', { className: 'link-more', href: c.href }, '자세히') : null,
        ),
      ),
    ),
  );
}

function List({ rows }: { rows: HomeRow[] }): ReactNode {
  if (rows.length === 0) {
    return h(
      'section',
      { className: 'card state' },
      h('h2', { className: 't-lg' }, '등록한 공연이 없습니다'),
      h('a', { className: 'btn btn-primary', href: '/events/new' }, '새 공연 등록'),
    );
  }
  return h(
    'section',
    { className: 'col gap-3', 'aria-labelledby': 'h-list' },
    h('div', { className: 'section-title' }, h('h2', { id: 'h-list' }, '공연 목록'), h('a', { className: 'btn btn-primary', href: '/events/new' }, '새 공연 등록')),
    h(
      'form',
      { className: 'toolbar', role: 'search', 'aria-label': '공연 거르기', action: '/events' },
      Filter('f-review', '판매 승인'),
      Filter('f-sale', '판매 상태'),
      Filter('f-period', '기간'),
      h('div', { className: 'field grow' }, h('label', { className: 'label', htmlFor: 'f-q' }, '공연명'), h('input', { id: 'f-q', name: 'q', type: 'search', placeholder: '공연명으로 찾기' })),
    ),
    h(
      'div',
      { className: 'table-wrap table-scroll', role: 'region', 'aria-label': '공연 목록 표', tabIndex: 0 },
      h(
        'table',
        { className: 'table' },
        h('caption', { className: 'sr-only' }, `공연 목록 ${rows.length}건, 첫 오픈 늦은 순. 판매 승인 상태와 다음 할 일`),
        h(
          'thead',
          null,
          h('tr', null, ...['공연', '회차 수', '판매 승인', '첫 오픈', '판매 상태', '다음 할 일'].map((x) => h('th', { key: x, scope: 'col' }, x))),
        ),
        h(
          'tbody',
          null,
          rows.map((r) =>
            h(
              'tr',
              { key: r.productionId },
              h('td', null, h('a', { className: 'fw-b', href: `/events/${r.productionId}` }, r.name), r.reviewNote ? h('span', { className: 't-xs muted', style: { display: 'block' } }, r.reviewNote) : null),
              h('td', { className: 'r' }, r.eventCount),
              h('td', null, h('span', { className: r.reviewBadge }, r.reviewLabel)),
              h('td', { className: 'num nowrap' }, r.firstOpenText),
              h('td', null, h('span', { className: r.saleStatusBadge }, r.saleStatusText)),
              h('td', null, r.nextActions.map((a) => h('a', { key: a.label, className: 'link-more', href: a.href }, a.label))),
            ),
          ),
        ),
      ),
    ),
    h(
      'ul',
      { className: 'col md:hidden', 'aria-label': `공연 목록 ${rows.length}건`, style: { gap: 12 } },
      rows.map((r) =>
        h(
          'li',
          { key: r.productionId, className: 'card col', style: { padding: 16, gap: 8 } },
          h('a', { className: 'fw-b', href: `/events/${r.productionId}` }, r.name),
          h('span', { className: r.reviewBadge }, r.reviewLabel),
          r.reviewNote ? h('span', { className: 't-xs muted' }, r.reviewNote) : null,
          h('span', { className: 't-sm' }, `회차 ${r.eventCount}개 · 첫 오픈 ${r.firstOpenText} · ${r.saleStatusText}`),
          h('div', { className: 'row wrap' }, r.nextActions.map((a) => h('a', { key: a.label, className: 'link-more', href: a.href }, a.label))),
        ),
      ),
    ),
  );
}

function Filter(id: string, label: string): ReactNode {
  return h(
    'div',
    { className: 'field' },
    h('label', { className: 'label', htmlFor: id }, label),
    h('select', { id, name: id === 'f-review' ? 'saleReview' : id === 'f-sale' ? 'saleStatus' : 'period' }, h('option', null, '전체')),
  );
}
