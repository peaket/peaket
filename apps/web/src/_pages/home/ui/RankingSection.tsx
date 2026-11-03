'use client';
// ⑧ 장르별 랭킹(d5 §5.1, CMP-030 chip 탭 + CMP-072 rank). 기준 문구 "어제 판매 매수 기준, 매일 오전 10시 갱신",
// 갱신 실패면 직전 파일의 판매일("10/12 판매 기준"). 칩은 ARIA 탭(←→·Home·End로 옮기고 고른다).
import Link from 'next/link';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { ProductionPoster } from '@/entities/production';
import { GENRES, type Genre } from '@/shared/config/genres';
import { cx } from '@/shared/lib/cx';
import type { HomeCard } from '../model/feed';
import { RailNextButton } from './RailNextButton';

const TABS: readonly { key: Genre | 'all'; label: string }[] = [{ key: 'all', label: '전체' }, ...GENRES.map((g) => ({ key: g.key, label: g.label }))];
const ITEM = 'flex-none w-[136px] md:w-[180px] lg:w-[calc((100%-96px)/5)]';
const RAIL = 'relative row items-stretch gap-3 overflow-x-auto px-4 [scrollbar-width:none] md:px-6 lg:gap-6 lg:px-8';

export function RankingSection({ cards, loading, stale }: { cards: readonly HomeCard[]; loading: boolean; stale: boolean }) {
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('all');
  const base = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const list = (tab === 'all' ? cards : cards.filter((c) => c.genre === tab)).slice(0, 10);
  const railId = `${base}-rail`;
  const panelId = `${base}-panel`;

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const i = TABS.findIndex((t) => t.key === tab);
    let to = -1;
    if (e.key === 'ArrowRight') to = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') to = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = TABS.length - 1;
    if (to < 0) return;
    e.preventDefault();
    setTab(TABS[to]!.key);
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
        {stale ? (
          <p className="row t-sm muted" style={{ gap: 6 }}>
            <i className="ic ic-history ic-16" aria-hidden="true" />
            10/12 판매 기준
          </p>
        ) : (
          <p className="t-sm muted">어제 판매 매수 기준, 매일 오전 10시 갱신</p>
        )}
      </div>
      <div className="row gap-2 overflow-x-auto px-4 [scrollbar-width:none] md:px-6 lg:px-8" role="tablist" aria-label="랭킹 장르" onKeyDown={onKey}>
        {TABS.map((t, i) => (
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
              {list.map((c, i) => (
                <li key={c.id} className={ITEM}>
                  <article>
                    <Link className="col gap-2.5 lg:gap-3" href={c.href} style={{ color: 'inherit' }}>
                      <ProductionPoster
                        art={c.art}
                        label={`${c.title} 포스터`}
                        kicker={c.kicker}
                        title={c.posterTitle}
                        sub={c.sub}
                        kickerClassName="hidden lg:block"
                        subClassName="hidden lg:block"
                        titleClassName="text-base leading-[18px] lg:text-[22px] lg:leading-6"
                      />
                      <div className="row items-start gap-2 lg:gap-3">
                        <span className="t-lg num min-w-3.5 lg:min-w-5 lg:text-2xl lg:leading-8">
                          {i + 1}
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
