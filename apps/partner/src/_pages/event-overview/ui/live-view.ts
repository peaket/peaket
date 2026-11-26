// SCR-063 라이브 화면의 순수 렌더(TR-03). 훅·fetch 없이 상태를 받아 글자·요소만 그린다.
// `LiveEventOverview.tsx`가 API 결과를 이 뷰에 넘긴다. 값은 React 글자 노드로만 넣는다.
import { createElement, type ReactNode } from 'react';
import type { EventRow, ProgressStep } from '../model/live';

export type OverviewViewMode = 'loading' | 'error' | 'notFound' | 'ready';

export interface OverviewProductionView {
  id: string;
  name: string;
  reviewLabel: string;
  reviewBadge: string;
  firstOpenText: string;
  meta: string;
  roundCount: number;
}

export interface OverviewLiveViewProps {
  mode: OverviewViewMode;
  production?: OverviewProductionView;
  progress?: { steps: ProgressStep[]; current: number };
  rounds?: EventRow[];
  seller?: { notice: string; fields: { label: string; value: string }[] } | null;
  message?: string | null;
}

const h = createElement;

export function OverviewLiveView({ mode, production, progress, rounds = [], seller = undefined, message = null }: OverviewLiveViewProps): ReactNode {
  if (mode === 'loading') return h('div', { className: 'col gap-4' }, h('h1', null, '공연 개요'), h('p', { role: 'status' }, '공연 개요를 불러오고 있습니다'));
  if (mode === 'notFound') {
    return h(
      'section',
      { className: 'card state' },
      h('h1', { className: 't-lg' }, '공연을 찾을 수 없습니다'),
      h('p', { className: 't-sm muted' }, '없는 공연이거나 다른 파트너의 공연입니다.'),
      h('a', { className: 'btn btn-outline', href: '/events' }, '공연 관리로 돌아가기'),
    );
  }
  if (mode === 'error') {
    return h(
      'section',
      { className: 'card state', role: 'alert' },
      h('h1', { className: 't-lg' }, '공연 개요를 불러오지 못했습니다'),
      message ? h('p', { className: 't-sm' }, message) : null,
      h('a', { className: 'btn btn-outline', href: '/events' }, '다시 시도'),
    );
  }
  if (!production) return h('h1', null, '공연 개요');
  return h(
    'div',
    { className: 'col gap-5' },
    h(
      'div',
      { className: 'page-head' },
      h('h1', null, production.name),
      h('span', { className: production.reviewBadge }, production.reviewLabel),
      h('p', { className: 't-sm muted' }, production.meta),
    ),
    Progress(progress),
    Rounds(production, rounds),
    Shortcuts(production),
    Seller(seller),
  );
}

function Progress(progress: OverviewLiveViewProps['progress']): ReactNode {
  if (!progress) return null;
  return h(
    'section',
    { className: 'card col gap-3', 'aria-labelledby': 'h-prog' },
    h('h2', { className: 't-md fw-b', id: 'h-prog' }, '진행 단계'),
    h(
      'nav',
      { className: 'stepper', 'aria-label': '공연 진행 단계' },
      progress.steps.map((s, i) =>
        h(
          'span',
          { className: `step${i < progress.current ? ' is-done' : ''}${i === progress.current ? ' is-current' : ''}`, key: s.label, 'aria-current': i === progress.current ? 'step' : undefined },
          h('span', { className: 'step-num' }, i < progress.current ? '✓' : String(i + 1)),
          h('span', { className: 'col' }, h('span', null, s.label), h('span', { className: 't-xs muted' }, s.meta)),
        ),
      ),
    ),
  );
}

function Rounds(production: OverviewProductionView, rounds: EventRow[]): ReactNode {
  return h(
    'section',
    { className: 'card col gap-3', 'aria-labelledby': 'h-rounds' },
    h('div', { className: 'section-title' }, h('h2', { id: 'h-rounds' }, '회차'), h('span', { className: 't-sm muted' }, `${production.roundCount}개`)),
    rounds.length === 0
      ? h('p', { className: 't-sm muted' }, '등록된 회차가 없습니다')
      : h(
          'div',
          { className: 'table-wrap table-scroll', role: 'region', 'aria-label': '회차 표', tabIndex: 0 },
          h(
            'table',
            { className: 'table dense' },
            h('caption', { className: 'sr-only' }, `회차 ${rounds.length}개의 공연 시작, 입장 시작, 종료 예정, 판매 상태, 판매율`),
            h('thead', null, h('tr', null, ...['공연 시작', '입장 시작', '종료 예정', '판매 상태', '판매율'].map((x) => h('th', { key: x, scope: 'col' }, x)))),
            h(
              'tbody',
              null,
              rounds.map((r) =>
                h(
                  'tr',
                  { key: r.eventId },
                  h('td', { className: 'fw-b nowrap' }, r.startsAt),
                  h('td', { className: 'num nowrap' }, r.doorsAt),
                  h('td', { className: 'num nowrap' }, r.endsAt),
                  h('td', null, r.saleStatusText),
                  h('td', { className: 'r' }, r.saleRateText),
                ),
              ),
            ),
          ),
        ),
  );
}

function Shortcuts(production: OverviewProductionView): ReactNode {
  const id = production.id;
  const items = [
    { href: `/events/${id}/live`, title: '판매 현황', desc: '오픈 뒤 약 1분 늦은 잠정 집계' },
    { href: `/events/${id}/staff`, title: '현장', desc: '스태프·기기 배치' },
    { href: `/events/${id}/settlement`, title: '정산·명단', desc: '정산서는 회차가 끝난 다음 영업일에 만듭니다' },
    { href: `/events/${id}/cancellation`, title: '회차 취소', desc: '취소·연기 요청과 판정 상태' },
  ];
  return h(
    'section',
    { className: 'card col gap-2', 'aria-labelledby': 'h-go' },
    h('h2', { className: 't-md fw-b', id: 'h-go' }, '바로가기'),
    items.map((x) => h('a', { key: x.title, className: 'link-more', href: x.href }, `${x.title} — ${x.desc}`)),
  );
}

function Seller(seller: OverviewLiveViewProps['seller']): ReactNode {
  if (seller === undefined) return null;
  if (seller === null) return h('p', { className: 'banner banner-warning', role: 'status' }, '판매자 정보를 불러오지 못했습니다.');
  return h(
    'section',
    { className: 'card col gap-3', 'aria-labelledby': 'h-notice' },
    h('h2', { className: 't-md fw-b', id: 'h-notice' }, '판매자 고지 미리보기'),
    h('div', { className: 'banner banner-legal' }, h('span', { className: 'banner-body' }, seller.notice)),
    h(
      'dl',
      { className: 'kv' },
      seller.fields.map((f) => [h('dt', { key: `${f.label}-t` }, f.label), h('dd', { key: `${f.label}-d` }, f.value)]),
    ),
  );
}
