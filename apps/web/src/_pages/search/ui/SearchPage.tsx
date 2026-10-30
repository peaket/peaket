// SCR-003 검색(d5 §5.3, d3 SCR-003 행, planning/04 SCR-003, 캔버스 보드 SCR-003-m·t·d를 한 페이지 반응형으로 합쳤다).
// 검색 입력은 셸 머리 검색창 하나다(이 화면 본문에 두 번째 입력이 없다, ADR-0063·0094).
//   휴대폰·태블릿: 셸 머리가 처음부터 검색 모드다({ 검색창 } [취소], search.barOpen). [취소]는 앞 화면으로 돌아간다.
//   데스크톱(lg): 셸 머리의 통합 검색창이 입력이다. 처음 검색어와 자동완성 창 상태(최근 검색어·자동완성·자동완성 없음·불러오는 중)를 셸 search로 넣는다.
// 휴대폰: 필터 칩(가로 스크롤) → 결과 수·정렬 → 결과 줄(포스터 76) → 페이지 번호. 태블릿(md): 칩 줄바꿈, 결과 두 칸(포스터 92).
// 데스크톱(lg): 1280 상자 12칸 — 왼쪽 3칸 필터 패널, 오른쪽 9칸 결과(네 칸 포스터 카드). 상태는 ?state=(보드 값), 다크는 ?theme=dark.
import Link from 'next/link';
import type { Metadata } from 'next';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { ProductionPoster, type ProductionStatus } from '@/entities/production';
import { SCR003_STATES } from '@/shared/config/screens.discovery';
import { cx } from '@/shared/lib/cx';
import { firstParam, type PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell, BOARD_SUGGESTIONS } from '@/widgets/app-shell';
import { josa, NO_FILTERS, searchUrl, searchView, type ResultCard, type SearchView } from '../model/search';
import { FilterChips, FilterPanel } from './Filters';
import { SortSelect } from './SortSelect';

/** 검색 화면은 검색 엔진 색인에서 뺀다(noindex, follow, d5 §5.3) */
export const searchMetadata: Metadata = { title: '검색', robots: { index: false, follow: true } };

const STATUS_BADGE: Record<ProductionStatus, { text: string; cls: string }> = {
  upcoming: { text: '오픈 예정', cls: 'badge badge-primary' },
  on_sale: { text: '판매 중', cls: 'badge badge-success' },
  sold_out: { text: '매진', cls: 'badge badge-danger' },
  ended: { text: '판매 종료', cls: 'badge' },
};

/** 결과 수 제목: 휴대폰 t-md 굵게 · 태블릿 t-lg · 데스크톱 t-xl */
const H_RES = 't-md fw-b md:text-xl md:leading-[27px] lg:text-2xl lg:leading-8';

export async function SearchPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const picked = firstParam(sp, 'state');
  const state = picked !== undefined ? resolvePreviewState(sp, SCR003_STATES, '결과') : null;
  const dark = resolvePreviewTheme(sp) === 'dark';
  const v = searchView(sp, state);
  const fp = { q: v.q, filters: v.filters, sort: v.sort };

  return (
    <AppShell
      key={`${state ?? 'live'}-${v.q}`}
      variant="default"
      current="events"
      dark={dark}
      search={{
        defaultValue: v.q,
        popup: v.combobox,
        // 보드 '자동완성'(입력 '루멘')의 후보 셋과 고른 줄(둘째, 아티스트)
        popupSuggestions: v.combobox === 'suggest' ? BOARD_SUGGESTIONS : undefined,
        activeIndex: v.combobox === 'suggest' ? 1 : undefined,
        barOpen: true,
      }}
    >
      <main className="page-main pb-10 md:px-6 md:pt-4 md:pb-12 lg:px-8 lg:pt-8 lg:pb-16" id="main" tabIndex={-1}>
        <h1 className="sr-only">공연 검색</h1>
        <div className="mx-auto w-full max-w-[1216px] lg:grid lg:grid-cols-12 lg:items-start lg:gap-x-6">
          <div className="lg:hidden">
            <FilterChips {...fp} />
          </div>
          <FilterPanel {...fp} className="hidden lg:col-span-3 lg:block" />
          <section className="col gap-3.5 px-4 pt-5 md:gap-4 md:px-0 md:pt-6 lg:col-span-9 lg:pt-0" aria-labelledby="h-res">
            <Results v={v} />
          </section>
        </div>
      </main>
      <PreviewSwitcher path="/search" states={SCR003_STATES} current={state ?? '결과'} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
  );
}

function Results({ v }: { v: SearchView }) {
  const fp = { q: v.q, filters: v.filters, sort: v.sort };
  if (v.result === 'loading') {
    return (
      <div className="col gap-3.5 md:gap-4 lg:gap-6">
        <div className="row between" style={{ gap: 8 }}>
          <h2 className={H_RES} id="h-res" tabIndex={-1}>
            검색 결과
          </h2>
          <span className="skel h-10 w-[118px] md:w-[180px]" />
        </div>
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4 lg:grid-cols-4 lg:gap-x-5 lg:gap-y-7" aria-busy="true" aria-label="검색 결과를 불러오는 중">
          {[80, 70, 75, 72].map((w, i) => (
            <li key={w} className={cx('card flex gap-3.5 p-3 lg:flex-col lg:gap-0 lg:overflow-hidden lg:p-0', i === 3 && 'hidden lg:flex')}>
              <span className="skel h-[101px] w-[76px] flex-none md:h-[123px] md:w-[92px] lg:aspect-[3/4] lg:h-auto lg:w-full lg:rounded-none" />
              <span className="col grow gap-2 pt-0.5 lg:px-3.5 lg:pt-3.5 lg:pb-4">
                <span className="skel" style={{ height: 18, width: `${w}%` }} />
                <span className="skel" style={{ height: 14, width: `${w - 20}%` }} />
                <span className="skel" style={{ height: 14, width: '40%' }} />
                <span className="skel" style={{ height: 22, width: 64 }} />
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (v.result === 'error') {
    return (
      <div className="col gap-2 md:gap-4">
        <h2 className={H_RES} id="h-res" tabIndex={-1}>
          검색 결과
        </h2>
        <div className="state px-2 pt-8 pb-2 lg:rounded-(--r-xl) lg:bg-(--surface-muted) lg:px-6 lg:py-16" role="alert">
          <span className="state-icon is-danger">
            <i className="ic ic-alert-circle" aria-hidden="true" />
          </span>
          <p className="t-md fw-b">검색하지 못했습니다. 다시 시도해 주세요</p>
          <Link className="btn btn-outline" href={searchUrl(fp)} prefetch={false}>
            <i className="ic ic-refresh" aria-hidden="true" />
            다시 시도
          </Link>
        </div>
      </div>
    );
  }
  if (v.result === 'empty' || v.result === 'empty-filter') {
    return (
      <>
        <div className="col gap-2 md:gap-4">
          <h2 className={H_RES} id="h-res" tabIndex={-1}>
            검색 결과 <span className="num">0</span>개
          </h2>
          <div className="state px-2 pt-8 pb-2 lg:rounded-(--r-xl) lg:bg-(--surface-muted) lg:px-6 lg:py-16">
            <span className="state-icon">
              <i className="ic ic-search" aria-hidden="true" />
            </span>
            <p className="t-lg" role="status">
              검색 결과가 없습니다
            </p>
            {v.didYouMean ? (
              <Link className="link t-md" href={searchUrl({ ...fp, q: v.didYouMean, filters: v.filters })}>
                혹시 &apos;{v.didYouMean}&apos;{josa(v.didYouMean, '을')} 찾으셨나요?
              </Link>
            ) : null}
            {v.result === 'empty-filter' && v.unfilteredCount ? (
              <>
                <p className="t-md">
                  필터를 풀면 <span className="num">{v.unfilteredCount}</span>개가 있습니다
                </p>
                <Link className="btn btn-outline btn-sm" href={searchUrl(fp, { filters: NO_FILTERS })}>
                  <i className="ic ic-filter" aria-hidden="true" />
                  필터 풀기
                </Link>
              </>
            ) : null}
          </div>
        </div>
        {v.popular?.length ? <SmallCards id="h-pop" title="오픈 예정 인기 공연" cards={v.popular} meta="open" /> : null}
      </>
    );
  }
  return (
    <>
      <div className="col gap-3.5 md:gap-4 lg:gap-6">
        <div className="row between gap-2 md:gap-3 lg:gap-4">
          <h2 className={H_RES} id="h-res" tabIndex={-1}>
            검색 결과 <span className="num">{v.total.toLocaleString('ko-KR')}</span>개
          </h2>
          <SortSelect {...fp} />
        </div>
        {v.converted ? (
          <p className="row wrap t-sm items-center" style={{ gap: '4px 6px' }}>
            <i className="ic ic-info ic-16 muted" aria-hidden="true" />
            <span>
              &apos;{v.converted.to}&apos;{josa(v.converted.to, '으로')} 찾은 결과입니다
            </span>
            <span className="muted" aria-hidden="true">
              ·
            </span>
            <Link className="link" href={`/search?q=${encodeURIComponent(v.converted.from)}&exact=1`}>
              &apos;{v.converted.from}&apos;{josa(v.converted.from, '으로')} 찾기
            </Link>
          </p>
        ) : null}
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4 lg:grid-cols-4 lg:gap-x-5 lg:gap-y-7">
          {v.cards.map((c) => (
            <li key={c.id}>
              <ResultItem c={c} />
            </li>
          ))}
        </ul>
        {v.pages > 1 ? <Pager v={v} /> : null}
      </div>
      {v.related ? <SmallCards id="h-rel" title={v.related.title} cards={v.related.cards} meta="period" /> : null}
    </>
  );
}

/** CMP-072 ProductionCard(result): 휴대폰·태블릿은 왼쪽 작은 포스터 + 글, 데스크톱은 위 포스터 + 아래 글 */
function ResultItem({ c }: { c: ResultCard }) {
  const badge = STATUS_BADGE[c.status];
  const label = `${c.title} 포스터`;
  return (
    <article className="h-full">
      <Link className="card flex h-full gap-3.5 p-3 md:gap-4 md:p-3.5 lg:flex-col lg:gap-0 lg:overflow-hidden lg:p-0" href={c.href} style={{ color: 'inherit' }}>
        <ProductionPoster art={c.poster.art} size="sm" title={c.poster.short} label={label} className="w-[76px] md:w-[92px] lg:hidden" />
        <ProductionPoster
          art={c.poster.art}
          title={c.poster.title}
          kicker={c.poster.kicker}
          sub={c.poster.sub}
          label={label}
          className="hidden rounded-none! lg:flex"
        />
        <div className="col grow gap-1 pt-0.5 lg:gap-1.5 lg:px-3.5 lg:pt-3.5 lg:pb-4">
          <h3 className="t-md fw-b">{c.title}</h3>
          <p className="t-sm muted">{c.period}</p>
          <p className="t-sm muted">{c.venue}</p>
          <div className="row mt-1">
            <span className={badge.cls}>{badge.text}</span>
          </div>
        </div>
      </Link>
    </article>
  );
}

/** ⑧ 작은 카드 줄(오픈 예정 인기 공연 · '{아티스트}의 다른 공연'): 휴대폰 가로 스크롤, 태블릿 이상 세 칸 */
function SmallCards({ id, title, cards, meta }: { id: string; title: string; cards: ResultCard[]; meta: 'open' | 'period' }) {
  return (
    <section className="col gap-3 pt-2" aria-labelledby={id}>
      <h2 className="t-md fw-b md:text-xl md:leading-[27px]" id={id}>
        {title}
      </h2>
      <ul className="relative -mx-4 row items-stretch gap-3 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:grid md:grid-cols-3 md:gap-4 md:overflow-visible md:px-0">
        {cards.map((c) => {
          const badge = STATUS_BADGE[c.status];
          return (
            <li key={c.id} className="w-64 flex-none md:w-auto">
              <Link className="card row h-full" href={c.href} style={{ gap: 12, padding: 12, color: 'inherit' }}>
                <ProductionPoster art={c.poster.art} size="sm" title={c.poster.short} label={`${c.title} 포스터`} style={{ width: 56 }} />
                <div className="col grow" style={{ gap: 4, minWidth: 0 }}>
                  <h3 className="t-sm fw-b ellipsis">{c.title}</h3>
                  <p className="t-xs muted">{meta === 'open' ? c.openMeta : `${c.period} · ${c.venue}`}</p>
                  <div className="row">
                    <span className={badge.cls}>{badge.text}</span>
                  </div>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** ⑥ 페이지 번호(SEED pagination-button 모양, 키트 .pager·.pg): 이전 · 1 2 3 … n · 다음, 현재 페이지 aria-current="page" */
function Pager({ v }: { v: SearchView }) {
  const fp = { q: v.q, filters: v.filters, sort: v.sort };
  const nums = pageNumbers(v.page, v.pages);
  const pg = 'pg h-11 min-w-9 md:h-10 md:min-w-10 lg:h-auto lg:min-w-8';
  const edge = 'pg inline-flex gap-0.5 px-2 h-11 md:h-10 md:px-2.5 lg:h-auto';
  return (
    <nav className="pager justify-center gap-0.5 pt-2 md:gap-1 lg:gap-1.5 lg:pt-0" aria-label="검색 결과 페이지">
      {v.page > 1 ? (
        <Link className={edge} href={searchUrl(fp, { page: v.page - 1 })} style={{ color: 'var(--text)' }}>
          <i className="ic ic-chevron-left ic-16" aria-hidden="true" />
          이전
        </Link>
      ) : (
        <a className={edge} aria-disabled="true" style={{ color: 'var(--text-disabled)', cursor: 'not-allowed' }}>
          <i className="ic ic-chevron-left ic-16" aria-hidden="true" />
          이전
        </a>
      )}
      {nums.map((n, i) =>
        n === null ? (
          <span key={`gap-${i}`} className="pg h-11 min-w-5 md:h-10 lg:h-auto" aria-hidden="true" style={{ cursor: 'default' }}>
            …
          </span>
        ) : (
          <Link key={n} className={pg} href={searchUrl(fp, { page: n })} aria-current={n === v.page ? 'page' : undefined}>
            <span className="sr-only">페이지 </span>
            {n}
          </Link>
        ),
      )}
      {v.page < v.pages ? (
        <Link className={edge} href={searchUrl(fp, { page: v.page + 1 })} style={{ color: 'var(--text)' }}>
          다음
          <i className="ic ic-chevron-right ic-16" aria-hidden="true" />
        </Link>
      ) : (
        <a className={edge} aria-disabled="true" style={{ color: 'var(--text-disabled)', cursor: 'not-allowed' }}>
          다음
          <i className="ic ic-chevron-right ic-16" aria-hidden="true" />
        </a>
      )}
    </nav>
  );
}

/** 1 2 3 … n (보드: 1쪽이면 1 2 3 … 7) */
function pageNumbers(page: number, pages: number): (number | null)[] {
  if (pages <= 5) return Array.from({ length: pages }, (_, i) => i + 1);
  const set = new Set([1, pages, page - 1, page, page + 1, ...(page <= 2 ? [2, 3] : []), ...(page >= pages - 1 ? [pages - 2, pages - 1] : [])]);
  const list = [...set].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out: (number | null)[] = [];
  list.forEach((n, i) => {
    if (i > 0 && n - list[i - 1]! > 1) out.push(null);
    out.push(n);
  });
  return out;
}
