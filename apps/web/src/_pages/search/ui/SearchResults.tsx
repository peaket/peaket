'use client';
// SCR-003 검색 결과(d5 §5.3 상태 표, docs/features/search.md §5·§6·§7.3, BUILD_ORDER HOT-312). 화면은 캐시되는 정적 셸이고, 이 부품이
// 주소(useSearchParams)를 읽어 검색 API(`GET /v1/search`, CDN 캐시)를 부르고 결과를 그린다. 새 검색어·필터·쪽이면 이전 요청을 취소한다.
// - 로딩: 결과 줄 뼈대. 에러: "검색하지 못했습니다. 다시 시도해 주세요" [다시 시도](같은 조건으로 다시 부른다).
// - 0건: 비슷한 이름 제안, 필터 풀기(필터가 있으면), 오픈 예정 인기 공연. 바꿔 찾음: 결과 위 안내와 원래 값으로 찾기(noConvert).
// - 없는 쪽: 마지막 쪽으로 주소를 바꾼다. 쪽을 바꾸면 결과 맨 위로 스크롤하고 초점을 '검색 결과 n개' 제목으로 옮긴다.
// api-client는 늦게 가져온다(첫 화면 JS 예산, docs/frontend.md §5.8).
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SEARCH_QUERY_SYNC_EVENT } from '@peaket/ds/WebShell';
import { cx } from '@/shared/lib/cx';
import { PicturePoster } from '@/shared/ui/PicturePoster';
import { hasFilters, josa, NO_FILTERS, pageNumbers, readQuery, searchUrl, toApiParams, toResultView, type CardStatus, type ResultCard, type ResultView, type SearchQuery } from '../model/search';
import { FilterChips, FilterPanel } from './Filters';
import { SortSelect } from './SortSelect';

const STATUS_BADGE: Record<CardStatus, { text: string; cls: string }> = {
  upcoming: { text: '오픈 예정', cls: 'badge badge-primary' },
  on_sale: { text: '판매 중', cls: 'badge badge-success' },
  sold_out: { text: '매진', cls: 'badge badge-danger' },
  ended: { text: '판매 종료', cls: 'badge' },
};

/** 결과 수 제목: 휴대폰 t-md 굵게 · 태블릿 t-lg · 데스크톱 t-xl */
const H_RES = 't-md fw-b md:text-xl md:leading-[27px] lg:text-2xl lg:leading-8';

/** 어느 주소(key)의 결과인지 함께 둔다. 주소가 바뀐 직후 옛 결과를 새 주소와 섞어 그리지 않는다(뒤로 가기 때 옛 쪽 수로 주소를 덮어쓰던 결함) */
type State = { key: string } & ({ kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; view: ResultView });

/** 주소의 검색 조건으로 검색 API를 부른다(같은 조건이면 다시 부르지 않는다, retry를 올리면 다시 부른다) */
function useSearch(query: SearchQuery, key: string, retry: number): State {
  const [state, setState] = useState<State>({ key, kind: 'loading' });
  useEffect(() => {
    const ctrl = new AbortController();
    setState({ key, kind: 'loading' });
    void (async () => {
      try {
        const [{ listSearchResults }, api] = await Promise.all([import('@peaket/api-client/endpoints/catalog'), import('@/shared/api')]);
        api.ensureBrowserApi();
        const r = await listSearchResults(toApiParams(query), { signal: ctrl.signal });
        if (!ctrl.signal.aborted) setState({ key, kind: 'ready', view: toResultView(r.data) });
      } catch {
        if (!ctrl.signal.aborted) setState({ key, kind: 'error' });
      }
    })();
    return () => ctrl.abort();
    // key가 검색 조건 전체다(query는 그때마다 새 객체)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry]);
  // 다른 주소의 결과는 아직 불러오는 중으로 본다
  return state.key === key ? state : { key, kind: 'loading' };
}

export function SearchResults() {
  const params = useSearchParams();
  const key = params.toString();
  const query = useMemo(() => readQuery(new URLSearchParams(key)), [key]);
  const [retry, setRetry] = useState(0);
  // 같은 검색 화면 안의 이동(링크·필터)은 popstate가 없어 머리 입력이 주소의 q를 다시 읽게 알린다(ds WebSearchBox queryFromUrl)
  useEffect(() => {
    window.dispatchEvent(new Event(SEARCH_QUERY_SYNC_EVENT));
  }, [key]);
  const state = useSearch(query, key, retry);
  const router = useRouter();
  const heading = useRef<HTMLHeadingElement>(null);
  /** 쪽 번호 링크를 눌러 이동한 주소(그 결과가 오면 초점을 옮긴다. 필터 변경과 가른다) */
  const pagedTo = useRef<string | null>(null);

  // 없는 쪽이면 마지막 쪽을 보인다(d5 §5.3). 이 주소의 결과로만 판정한다
  useEffect(() => {
    if (state.kind === 'ready' && state.key === key && state.view.pages > 0 && query.page > state.view.pages) router.replace(searchUrl(query, { page: state.view.pages }), { scroll: false });
  }, [state, key, query, router]);
  // 쪽을 바꾸면 새 결과가 온 뒤 결과 맨 위로, 초점은 결과 수 제목으로(d5 §5.3)
  useEffect(() => {
    if (state.kind !== 'ready' || pagedTo.current !== key) return;
    pagedTo.current = null;
    heading.current?.scrollIntoView({ block: 'start' });
    heading.current?.focus({ preventScroll: true });
  }, [state, key]);
  const onPage = (href: string) => {
    pagedTo.current = new URLSearchParams(href.split('?')[1] ?? '').toString();
  };

  const names = state.kind === 'ready' ? { placeName: state.view.placeName, artistName: state.view.artistName } : {};
  return (
    <div className="mx-auto w-full max-w-[1216px] lg:grid lg:grid-cols-12 lg:items-start lg:gap-x-6">
      <div className="lg:hidden">
        <FilterChips query={query} {...names} openGroup={params.get('filter') ?? undefined} />
      </div>
      <FilterPanel query={query} {...names} className="hidden lg:col-span-3 lg:block" />
      <section className="col gap-3.5 px-4 pt-5 md:gap-4 md:px-0 md:pt-6 lg:col-span-9 lg:pt-0" aria-labelledby="h-res">
        {state.kind === 'loading' ? (
          <ResultsSkeleton />
        ) : state.kind === 'error' ? (
          <div className="col gap-2 md:gap-4">
            <h2 className={H_RES} id="h-res" tabIndex={-1} ref={heading}>
              검색 결과
            </h2>
            <div className="state px-2 pt-8 pb-2 lg:rounded-(--r-xl) lg:bg-(--surface-muted) lg:px-6 lg:py-16" role="alert">
              <span className="state-icon is-danger">
                <i className="ic ic-alert-circle" aria-hidden="true" />
              </span>
              <p className="t-md fw-b">검색하지 못했습니다. 다시 시도해 주세요</p>
              <button className="btn btn-outline" type="button" onClick={() => setRetry((n) => n + 1)}>
                <i className="ic ic-refresh" aria-hidden="true" />
                다시 시도
              </button>
            </div>
          </div>
        ) : (
          <Results v={state.view} query={query} heading={heading} onPage={onPage} />
        )}
      </section>
    </div>
  );
}

/** 필터 자리 뼈대(정적 셸의 대체 화면, 스크립트가 붙은 뒤 화면이 밀리지 않게): 휴대폰·태블릿 칩 줄, 데스크톱 왼쪽 패널 */
export function SearchShellSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[1216px] lg:grid lg:grid-cols-12 lg:items-start lg:gap-x-6" aria-busy="true">
      <div className="row gap-2 overflow-hidden px-4 pt-4 md:flex-wrap md:px-0 md:pt-0 lg:hidden" aria-hidden="true">
        {[52, 76, 76, 64, 72, 96].map((w, i) => (
          <span key={i} className="skel flex-none" style={{ height: 36, width: w, borderRadius: 999 }} />
        ))}
      </div>
      <div className="hidden lg:col-span-3 lg:block" aria-hidden="true">
        <span className="skel block" style={{ height: 720, borderRadius: 'var(--r-xl)' }} />
      </div>
      <section className="col gap-3.5 px-4 pt-5 md:gap-4 md:px-0 md:pt-6 lg:col-span-9 lg:pt-0">
        <ResultsSkeleton />
      </section>
    </div>
  );
}

/** 결과 줄 뼈대(정적 셸에도 이 모양이 들어간다) */
export function ResultsSkeleton() {
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

function Results({ v, query, heading, onPage }: { v: ResultView; query: SearchQuery; heading: React.RefObject<HTMLHeadingElement | null>; onPage: (href: string) => void }) {
  if (v.total === 0) {
    return (
      <>
        <div className="col gap-2 md:gap-4">
          <h2 className={H_RES} id="h-res" tabIndex={-1} ref={heading}>
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
              <Link className="link t-md" href={searchUrl(query, { q: v.didYouMean, filters: query.filters })}>
                혹시 &apos;{v.didYouMean}&apos;{josa(v.didYouMean, '을')} 찾으셨나요?
              </Link>
            ) : null}
            {hasFilters(query.filters) && v.relaxedTotal ? (
              <>
                <p className="t-md">
                  필터를 풀면 <span className="num">{v.relaxedTotal.toLocaleString('ko-KR')}</span>개가 있습니다
                </p>
                <Link className="btn btn-outline btn-sm" href={searchUrl(query, { filters: NO_FILTERS })}>
                  <i className="ic ic-filter" aria-hidden="true" />
                  필터 풀기
                </Link>
              </>
            ) : null}
          </div>
        </div>
        {v.related ? <SmallCards id="h-pop" title={v.related.title} cards={v.related.cards} meta={v.related.kind === 'UPCOMING_POPULAR' ? 'open' : 'period'} /> : null}
      </>
    );
  }
  return (
    <>
      <div className="col gap-3.5 md:gap-4 lg:gap-6">
        <div className="row between gap-2 md:gap-3 lg:gap-4">
          <h2 className={H_RES} id="h-res" tabIndex={-1} ref={heading}>
            검색 결과 <span className="num">{v.total.toLocaleString('ko-KR')}</span>
            {v.totalCapped ? '개 넘게' : '개'}
          </h2>
          <SortSelect query={query} />
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
            <Link className="link" href={searchUrl(query, { q: v.converted.from, filters: query.filters, noConvert: true })}>
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
        {v.pages > 1 ? <Pager v={v} query={query} onPage={onPage} /> : null}
      </div>
      {v.related ? <SmallCards id="h-rel" title={v.related.title} cards={v.related.cards} meta="period" /> : null}
    </>
  );
}

/** CMP-072 ProductionCard(result): 휴대폰·태블릿은 왼쪽 작은 포스터 + 글, 데스크톱은 위 포스터 + 아래 글 */
function ResultItem({ c }: { c: ResultCard }) {
  const badge = STATUS_BADGE[c.status];
  return (
    <article className="h-full">
      <Link className="card flex h-full gap-3.5 p-3 md:gap-4 md:p-3.5 lg:flex-col lg:gap-0 lg:overflow-hidden lg:p-0" href={c.href} style={{ color: 'inherit' }}>
        <PicturePoster
          src={c.posterUrl}
          alt={c.posterAlt}
          width={300}
          height={400}
          sizes="(min-width: 1280px) 220px, (min-width: 768px) 92px, 76px"
          fallbackLabel={c.title}
          className="w-[76px] flex-none md:w-[92px] lg:w-full"
          style={{ borderRadius: 'var(--r-md)' }}
        />
        <div className="col grow gap-1 pt-0.5 lg:gap-1.5 lg:px-3.5 lg:pt-3.5 lg:pb-4">
          <h3 className="t-md fw-b">{c.title}</h3>
          {c.period ? <p className="t-sm muted">{c.period}</p> : null}
          {c.venue ? <p className="t-sm muted">{c.venue}</p> : null}
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
                <PicturePoster src={c.posterUrl} alt={c.posterAlt} width={300} height={400} sizes="56px" fallbackLabel={c.title} style={{ width: 56, flex: 'none', borderRadius: 'var(--r-sm)' }} />
                <div className="col grow" style={{ gap: 4, minWidth: 0 }}>
                  <h3 className="t-sm fw-b ellipsis">{c.title}</h3>
                  <p className="t-xs muted">{meta === 'open' ? c.openMeta : [c.period, c.venue].filter(Boolean).join(' · ')}</p>
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
function Pager({ v, query, onPage }: { v: ResultView; query: SearchQuery; onPage: (href: string) => void }) {
  const nums = pageNumbers(v.page, v.pages);
  const go = (page: number) => {
    const href = searchUrl(query, { page });
    return { href, onClick: () => onPage(href) };
  };
  const pg = 'pg h-11 min-w-9 md:h-10 md:min-w-10 lg:h-auto lg:min-w-8';
  const edge = 'pg inline-flex gap-0.5 px-2 h-11 md:h-10 md:px-2.5 lg:h-auto';
  return (
    <nav className="pager justify-center gap-0.5 pt-2 md:gap-1 lg:gap-1.5 lg:pt-0" aria-label="검색 결과 페이지">
      {v.page > 1 ? (
        <Link className={edge} {...go(v.page - 1)} scroll={false} style={{ color: 'var(--text)' }}>
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
          <Link key={n} className={pg} {...go(n)} scroll={false} aria-current={n === v.page ? 'page' : undefined}>
            <span className="sr-only">페이지 </span>
            {n}
          </Link>
        ),
      )}
      {v.page < v.pages ? (
        <Link className={edge} {...go(v.page + 1)} scroll={false} style={{ color: 'var(--text)' }}>
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
