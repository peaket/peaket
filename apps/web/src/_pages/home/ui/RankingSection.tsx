'use client';
// ⑧ 장르별 랭킹(d5 §5.1, CMP-030 chip 탭 + CMP-072 rank). 기준 문구 "어제 판매 매수 기준, 매일 오전 10시 갱신",
// 갱신 실패면 직전 파일의 판매일("10/12 판매 기준"), 2일 [가정] 넘게 밀렸거나 파일을 못 받으면 섹션을 숨긴다. 칩은 ARIA 탭(←→·Home·End로 옮기고 고른다).
// 랭킹 파일은 같은 출처 정적 파일(openapi getHomeRankings, 매일 게시, max-age 3600)이라 브라우저가 받는다(ADR-0199 결정 3).
// 장르 칩을 바꿔도 다시 받지 않는다(모든 장르가 한 파일에 있다).
import Link from 'next/link';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { GENRES, type Genre } from '@/shared/config/genres';
import { cx } from '@/shared/lib/cx';
import { PicturePoster } from '@/shared/ui/PicturePoster';
import { rankingBasis, toRankings, type Genre as ContractGenre, type RankCard, type Rankings } from '../model/feed';
import { RailNextButton } from './RailNextButton';

const TABS: readonly { key: Genre | 'all'; label: string }[] = [{ key: 'all', label: '전체' }, ...GENRES.map((g) => ({ key: g.key, label: g.label }))];
const ITEM = 'flex-none w-[136px] md:w-[180px] lg:w-[calc((100%-96px)/5)]';
const RAIL = 'relative row items-stretch gap-3 overflow-x-auto px-4 [scrollbar-width:none] md:px-6 lg:gap-6 lg:px-8';

type Loaded = { state: 'loading' } | { state: 'hidden' } | { state: 'ready'; rankings: Rankings; basis: { stale: boolean; text: string } };

export function RankingSection() {
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('all');
  const [data, setData] = useState<Loaded>({ state: 'loading' });
  const base = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    let live = true;
    // api-client는 늦게 가져온다(첫 화면 JS 예산, §5.8)
    Promise.all([import('@peaket/api-client/endpoints/catalog'), import('@/shared/api')])
      .then(([catalog, api]) => {
        api.ensureBrowserApi();
        return catalog.getHomeRankings();
      })
      .then((r) => {
        const now = new Date();
        const rankings = toRankings(r.data, now);
        const basis = rankings && rankingBasis(rankings.basisDate, now);
        if (live) setData(rankings && basis ? { state: 'ready', rankings, basis } : { state: 'hidden' });
      })
      .catch(() => {
        if (live) setData({ state: 'hidden' });
      });
    return () => {
      live = false;
    };
  }, []);

  // 순위가 하나도 없으면 섹션을 숨긴다(d5 §5.1 '섹션 비어 있음')
  if (data.state === 'hidden' || (data.state === 'ready' && data.rankings.overall.length === 0)) return null;
  const loading = data.state === 'loading';
  // 공연이 없는 장르 칩은 보이지 않는다(analytics §8.5). 받는 중에는 모든 칩을 보인다
  const tabs = data.state === 'ready' ? TABS.filter((t) => t.key === 'all' || (data.rankings.byGenre[t.label as ContractGenre]?.length ?? 0) > 0) : TABS;
  // 화면의 장르 키(영문)와 계약의 장르 값(정본 이름)이 달라 이름으로 찾는다
  const label = TABS.find((t) => t.key === tab)?.label as ContractGenre | undefined;
  const list: RankCard[] = data.state === 'ready' ? ((tab === 'all' ? data.rankings.overall : label ? data.rankings.byGenre[label] : undefined) ?? []) : [];
  const stale = data.state === 'ready' && data.basis.stale;
  const railId = `${base}-rail`;
  const panelId = `${base}-panel`;

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const i = tabs.findIndex((t) => t.key === tab);
    let to = -1;
    if (e.key === 'ArrowRight') to = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') to = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = tabs.length - 1;
    if (to < 0) return;
    e.preventDefault();
    setTab(tabs[to]!.key);
    tabRefs.current[to]?.focus();
  }

  return (
    <section className="col mx-auto w-full max-w-[1280px] gap-3 md:gap-3.5 lg:gap-4" aria-labelledby="h-rank">
      <div className="col gap-1 px-4 md:px-6 lg:px-8">
        <div className="section-title">
          <h2 id="h-rank" className="lg:text-[22px] lg:leading-[30px]">
            장르별 랭킹
          </h2>
        </div>
        {data.state !== 'ready' ? (
          <p className="t-sm muted">어제 판매 매수 기준, 매일 오전 10시 갱신</p>
        ) : stale ? (
          <p className="row t-sm muted" style={{ gap: 6 }}>
            <i className="ic ic-history ic-16" aria-hidden="true" />
            {data.basis.text}
          </p>
        ) : (
          <p className="t-sm muted">{data.basis.text}</p>
        )}
      </div>
      <div className="row gap-2 overflow-x-auto px-4 [scrollbar-width:none] md:px-6 lg:px-8" role="tablist" aria-label="랭킹 장르" onKeyDown={onKey}>
        {tabs.map((t, i) => (
          <button
            key={t.key}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            className={cx('chip chip-sm', t.key === tab && 'is-selected')}
            role="tab"
            type="button"
            id={`${base}-tab-${t.key}`}
            aria-selected={t.key === tab}
            aria-controls={panelId}
            tabIndex={t.key === tab ? 0 : -1}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={panelId} aria-labelledby={`${base}-tab-${tab}`} className="relative">
        {loading ? (
          <ol className={cx(RAIL, 'overflow-hidden')} aria-busy="true" aria-label="랭킹을 불러오는 중">
            {[0, 1, 2, 3, 4].map((k) => (
              <li key={k} className={cx('col', ITEM)} style={{ gap: 10 }}>
                <span className="skel" style={{ aspectRatio: '3/4' }} />
                <span className="skel" style={{ height: 18, width: '75%' }} />
                <span className="skel" style={{ height: 14, width: '50%' }} />
              </li>
            ))}
          </ol>
        ) : list.length === 0 ? (
          <p className="t-sm muted px-4 md:px-6 lg:px-8">이 장르의 랭킹이 아직 없습니다</p>
        ) : (
          <>
            <ol id={railId} className={RAIL}>
              {list.map((c) => (
                <li key={c.id} className={ITEM}>
                  <article>
                    <Link className="col gap-2.5 lg:gap-3" href={c.href} style={{ color: 'inherit' }}>
                      <PicturePoster src={c.posterUrl} alt={c.posterAlt} width={300} height={400} sizes="(min-width: 1280px) 220px, (min-width: 768px) 180px, 136px" className="rounded-(--r-md)" fallbackLabel={c.title} />
                      <div className="row items-start gap-2 lg:gap-3">
                        <span className="t-lg num min-w-3.5 lg:min-w-5 lg:text-2xl lg:leading-8">
                          {c.rank}
                          <span className="sr-only">위</span>
                        </span>
                        <div className="col min-w-0 gap-1">
                          <h3 className="t-sm fw-b">{c.title}</h3>
                          <p className="t-xs muted">{c.venue}</p>
                          {c.status === 'sold_out' ? (
                            <div className="row">
                              <span className="badge badge-danger">매진</span>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </Link>
                  </article>
                </li>
              ))}
            </ol>
            {list.length > 5 ? <RailNextButton targetId={railId} label="랭킹 다음 공연 보기" /> : null}
          </>
        )}
      </div>
    </section>
  );
}
