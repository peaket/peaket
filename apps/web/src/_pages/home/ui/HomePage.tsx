// SCR-001 홈(d5 §5.1, d3 SCR-001 행, 캔버스 보드 SCR-001-m·t·d를 한 페이지 반응형으로 합쳤다).
// 섹션: 배너 슬라이드 → 장르 바로가기 → 오픈 예정 → 찜한 공연(로그인) → 장르별 랭킹 → 지금 판매 중 → 굿즈 스토어 띠 → 테마 추천 → 공연장.
// 휴대폰 먼저, md 768(태블릿)·lg 1280(데스크톱, 본문 최대 1280에 바깥 여백 32 = 1216)에서 바뀐다. 상태는 ?state=(보드 state 값), 다크는 ?theme=dark.
import Link from 'next/link';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { ME } from '@/entities/me';
import { formatWon, ProductionPoster } from '@/entities/production';
import { OpenAlertProvider, OpenAlertToggle } from '@/features/open-alert';
import { HOME_GENRE_TILES, searchHref } from '@/shared/config/genres';
import { SCR001_STATES } from '@/shared/config/screens.discovery';
import { cx } from '@/shared/lib/cx';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { BANNERS, HOME_VENUES, likeSubText, ON_SALE, RANKING, statusBadge, THEMES, toCard, UPCOMING, type HomeCard } from '../model/feed';
import { homeView } from '../model/state';
import { BannerCarousel } from './BannerCarousel';
import { RailNextButton } from './RailNextButton';
import { RankingSection } from './RankingSection';

/** 가로 스크롤 카드 줄(CMP-071 rail): 휴대폰·태블릿은 손가락으로 넘기고, 데스크톱은 같은 줄을 열 수에 맞춰 나눈다.
 *  relative: 안의 sr-only(absolute) 글이 줄 밖 조상을 기준으로 잡혀 페이지 가로 스크롤을 만들지 않게 한다 */
const RAIL = 'relative row items-stretch gap-3 overflow-x-auto px-4 [scrollbar-width:none] md:px-6 lg:px-8';
/** 섹션 머리·본문의 가로 여백(데스크톱은 1280 상자 안 32) */
const GUTTER = 'px-4 md:px-6 lg:px-8';
const SECTION = 'col mx-auto w-full max-w-[1280px]';
const H2 = 'lg:text-[22px] lg:leading-[30px]';

export async function HomePage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR001_STATES, '기본');
  const dark = resolvePreviewTheme(sp) === 'dark';
  const v = homeView(state);
  const offlineId = v.offline ? 'off-msg' : undefined;

  return (
    <AppShell variant="default" current="home" dark={dark} guest={v.guest} offline={v.offline ? { lastSync: '20:04' } : null}>
      <OpenAlertProvider guest={v.guest} offlineReasonId={offlineId} loginHref="/login?next=%2F" defaultSheetOpen={v.showSheet}>
        <main className="page-main gap-8 pt-3 pb-10 md:gap-10 md:pt-4 md:pb-12 lg:gap-12 lg:pt-6 lg:pb-16" id="main" tabIndex={-1}>
          <h1 className="sr-only">PEAKET 홈</h1>

          {v.loading ? (
            <div className="px-4 md:px-6 lg:mx-auto lg:w-full lg:max-w-[1280px] lg:px-8" aria-busy="true">
              <span className="sr-only">배너를 불러오는 중</span>
              <span className="skel aspect-[1240/400] rounded-(--r-lg) md:aspect-auto md:h-[232px] md:rounded-(--r-xl) lg:h-[400px] lg:rounded-[20px]" />
              <span className="skel mt-2 h-8 w-1/2 md:hidden" />
            </div>
          ) : v.bannerShown ? (
            <BannerCarousel slides={BANNERS} initialPaused={v.paused} />
          ) : null}

          <GenreTiles />

          <UpcomingSection list={v.openList} loading={v.loading} empty={v.openEmpty} />

          {v.likeShown ? <LikesSection loading={v.loading} /> : null}

          <RankingSection cards={RANKING} loading={v.loading} stale={v.rankingStale} />

          <OnSaleSection loading={v.loading} />

          <GoodsBand />

          {v.loading ? <ThemesSkeleton /> : v.themeList ? <ThemesSection /> : null}

          <VenuesSection />
        </main>
      </OpenAlertProvider>
      <PreviewSwitcher path="/" states={SCR001_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
  );
}

/** ⑦ 장르 바로가기(CMP-002 tile): 휴대폰·태블릿 5×2, 데스크톱 한 줄 10칸 */
function GenreTiles() {
  return (
    <section className={cx(SECTION, GUTTER)} aria-labelledby="h-genre">
      <h2 className="sr-only" id="h-genre">
        장르 바로가기
      </h2>
      <ul className="grid grid-cols-5 gap-x-1 gap-y-3 md:gap-x-2 md:gap-y-4 lg:grid-cols-10 lg:gap-2">
        {HOME_GENRE_TILES.map((t) => (
          <li key={t.label}>
            <Link className="col items-center gap-1.5 rounded-(--r-lg) text-center lg:gap-2 lg:py-1.5" href={t.href} style={{ color: 'inherit' }}>
              <span
                className="center h-[52px] w-[52px] rounded-(--r-lg) md:h-14 md:w-14 lg:h-16 lg:w-16 lg:rounded-(--r-xl)"
                aria-hidden="true"
                style={{ background: 'var(--surface-muted)', color: 'var(--link)' }}
              >
                <i className={`ic ic-genre-${t.icon} h-6 w-6 lg:h-7 lg:w-7`} />
              </span>
              <span className="t-xs fw-m lg:text-sm lg:leading-[19px]">{t.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SectionHead({ id, title, more }: { id: string; title: string; more?: { href: string; label: string } }) {
  return (
    <div className={cx('section-title', GUTTER)}>
      <h2 id={id} className={H2}>
        {title}
      </h2>
      {more ? (
        <Link className="link-more" href={more.href}>
          {more.label}
          <i className="ic ic-chevron-right" aria-hidden="true" />
        </Link>
      ) : null}
    </div>
  );
}

/** ① 오픈 예정(CMP-072 poster): 글자 묶음 1행 = 오픈 일시(굵게) | 종 아이콘 토글. 카드 링크는 공연명 하나(ADR-0066) */
function UpcomingSection({ list, loading, empty }: { list: boolean; loading: boolean; empty: boolean }) {
  const item = 'flex-none w-[148px] md:w-[200px] lg:w-[calc((100%-96px)/5)]';
  return (
    <section className={cx(SECTION, 'gap-3 md:gap-3.5 lg:gap-4')} aria-labelledby="h-open">
      <SectionHead id="h-open" title="오픈 예정" more={{ href: searchHref.upcoming(), label: '전체보기' }} />
      {loading ? (
        <ul className={cx(RAIL, 'overflow-hidden lg:gap-6')} aria-busy="true" aria-label="오픈 예정 공연을 불러오는 중">
          {[0, 1, 2, 3, 4].map((k) => (
            <li key={k} className={cx('col', item)} style={{ gap: 10 }}>
              <span className="skel" style={{ aspectRatio: '3/4' }} />
              <span className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1">
                <span className="skel self-center" style={{ height: 18 }} />
                <span className="skel" style={{ width: 44, height: 44, borderRadius: 'var(--r-md)' }} />
                <span className="skel col-span-2" style={{ height: 14, width: '90%' }} />
              </span>
            </li>
          ))}
        </ul>
      ) : list ? (
        <div className="relative">
          <ul id="rail-open" className={cx(RAIL, 'lg:gap-6')}>
            {UPCOMING.map((c) => (
              <li key={c.id} className={item}>
                <article className="relative col h-full gap-2.5 lg:gap-3">
                  <ProductionPoster
                    art={c.art}
                    label={`${c.title} 포스터`}
                    kicker={c.kicker}
                    title={c.posterTitle}
                    sub={c.sub}
                    subClassName="hidden lg:block"
                    titleClassName="text-[18px] leading-[20px] lg:text-[22px] lg:leading-6"
                  />
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1">
                    <span className="t-sm fw-b num self-center lg:text-base lg:leading-[22px]">{c.openText} 오픈</span>
                    <OpenAlertToggle title={c.title} defaultPressed={ME.openAlertProductionIds.includes(c.id)} className="z-[1]" />
                    <h3 className="t-sm col-span-2 line-clamp-2">
                      {/* 카드 링크는 공연명 하나. 누르는 영역만 카드 전체로 넓히고(가상 요소), 종 토글은 그 위에 따로 둔다 */}
                      <Link href={c.href} className="after:absolute after:inset-0 after:content-['']" style={{ color: 'inherit' }}>
                        {c.title}
                      </Link>
                    </h3>
                    {c.upcomingBadge ? (
                      <div className="row wrap col-span-2" style={{ gap: 4 }}>
                        <span className={c.upcomingBadge.tone === 'primary' ? 'badge badge-primary' : 'badge'}>{c.upcomingBadge.text}</span>
                      </div>
                    ) : null}
                  </div>
                </article>
              </li>
            ))}
          </ul>
          <RailNextButton targetId="rail-open" label="오픈 예정 다음 공연 보기" />
        </div>
      ) : null}
      {empty ? (
        <div className={cx('px-4 md:px-6 lg:px-8')}>
          <div className="state card-flat px-4 py-8 lg:px-6 lg:py-12">
            <span className="state-icon">
              <i className="ic ic-calendar" aria-hidden="true" />
            </span>
            <p className="t-md fw-b">예정된 공연이 없습니다</p>
            <Link className="link-more" href={searchHref.all()}>
              공연 검색
              <i className="ic ic-chevron-right" aria-hidden="true" />
            </Link>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** ③ 찜한 공연(로그인한 경우만, CMP-072 compact) */
function LikesSection({ loading }: { loading: boolean }) {
  const item = 'flex-none w-[256px] md:w-[280px] lg:w-[calc((100%-48px)/4)]';
  const cards = ME.likedProductionIds.map(toCard);
  return (
    <section className={cx(SECTION, 'gap-3 md:gap-3.5 lg:gap-4')} aria-labelledby="h-like">
      <SectionHead id="h-like" title="찜한 공연" more={{ href: '/my/likes', label: '전체보기' }} />
      {loading ? (
        <ul className={cx(RAIL, 'overflow-hidden lg:gap-4')} aria-busy="true" aria-label="찜한 공연을 불러오는 중">
          {[0, 1, 2, 3].map((k) => (
            <li key={k} className={cx('card row', item)} style={{ gap: 12, padding: 12 }}>
              <span className="skel" style={{ width: 56, height: 75, flex: 'none' }} />
              <span className="col grow" style={{ gap: 8 }}>
                <span className="skel" style={{ height: 16, width: '85%' }} />
                <span className="skel" style={{ height: 12, width: '60%' }} />
                <span className="skel" style={{ height: 22, width: 56 }} />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <ul className={cx(RAIL, 'lg:gap-4')}>
          {cards.map((c) => {
            const b = statusBadge(c);
            return (
              <li key={c.id} className={item}>
                <Link className="card row h-full" href={c.href} style={{ gap: 12, padding: 12, color: 'inherit' }}>
                  <ProductionPoster art={c.art} size="sm" label={`${c.title} 포스터`} title={c.posterShort} style={{ width: 56 }} />
                  <div className="col grow" style={{ gap: 4 }}>
                    <h3 className="t-sm fw-b ellipsis">{c.title}</h3>
                    <p className="t-xs muted">{likeSubText(c)}</p>
                    <div className="row">
                      <span className={b.cls}>{b.text}</span>
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** ⑨ 지금 판매 중(CMP-072 horizontal): 휴대폰 1열 · 태블릿 2열 · 데스크톱 3열. 남은 기간은 글자로만 */
function OnSaleSection({ loading }: { loading: boolean }) {
  const grid = cx('grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4 lg:grid-cols-3 lg:gap-6', GUTTER);
  return (
    <section className={cx(SECTION, 'gap-3 md:gap-3.5 lg:gap-4')} aria-labelledby="h-onsale">
      <SectionHead id="h-onsale" title="지금 판매 중" />
      {loading ? (
        <ul className={grid} aria-busy="true" aria-label="판매 중인 공연을 불러오는 중">
          {[0, 1, 2].map((k) => (
            <li key={k} className="card row items-start gap-3.5 p-3 lg:gap-4 lg:p-4">
              <span className="skel h-[101px] w-[76px] flex-none lg:h-[139px] lg:w-[104px]" />
              <span className="col grow" style={{ gap: 8 }}>
                <span className="skel" style={{ height: 20, width: '60%' }} />
                <span className="skel" style={{ height: 18, width: '85%' }} />
                <span className="skel" style={{ height: 14, width: '50%' }} />
                <span className="skel" style={{ height: 18, width: '45%' }} />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <ul className={grid}>
          {ON_SALE.map((c) => (
            <li key={c.id}>
              <article className="h-full">
                <Link className="card row h-full items-start gap-3.5 p-3 lg:gap-4 lg:p-4" href={c.href} style={{ color: 'inherit' }}>
                  <ProductionPoster art={c.art} size="sm" label={`${c.title} 포스터`} title={c.posterShort} className="w-[76px] lg:w-[104px]" />
                  <div className="col grow gap-1 lg:gap-1.5">
                    <p className="row" style={{ gap: 8 }}>
                      <span className="badge badge-success">판매 중</span>
                      <span className="t-sm muted">{c.daysLeftText}</span>
                    </p>
                    <h3 className="t-md fw-b">{c.title}</h3>
                    <p className="t-sm muted">
                      {c.venue}
                      <span className="lg:hidden"> · {c.periodText}</span>
                    </p>
                    <p className="t-sm muted hidden lg:block">{c.periodText}</p>
                    <p className="t-md fw-b num lg:mt-0.5">{formatWon(c.minPrice)}부터</p>
                  </div>
                </Link>
              </article>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** ④ 공식 굿즈 스토어 띠 배너 → SCR-015 */
function GoodsBand() {
  return (
    <section className={cx(SECTION, GUTTER)} aria-label="공식 굿즈 스토어">
      <Link className="card-flat row gap-3.5 p-4 lg:gap-5 lg:px-7 lg:py-6" href="/shop" style={{ color: 'inherit' }}>
        <span className="state-icon is-primary h-12 w-12 lg:h-14 lg:w-14">
          <i className="ic ic-bag" aria-hidden="true" />
        </span>
        <span className="col grow gap-0.5 lg:gap-1">
          <span className="t-md fw-b lg:text-xl lg:leading-[27px]">공식 굿즈 스토어</span>
          <span className="t-sm muted">
            <span className="lg:hidden">공연 MD와 티켓 보유자 전용 상품</span>
            <span className="hidden lg:inline">공연 MD와 티켓 보유자 전용 상품을 한곳에서 봅니다. 현장 수령 상품은 수령 시간대를 함께 안내합니다.</span>
          </span>
        </span>
        <i className="ic ic-chevron-right lg:hidden" aria-hidden="true" />
        <span className="link-more hidden lg:inline-flex">
          스토어로 가기
          <i className="ic ic-chevron-right" aria-hidden="true" />
        </span>
      </Link>
    </section>
  );
}

function themeSub(c: HomeCard): { text: string; soldOut: boolean } {
  if (c.status === 'upcoming') return { text: `${c.openText} 오픈`, soldOut: false };
  if (c.status === 'sold_out') return { text: `회차 ${c.roundCount}개`, soldOut: true };
  return { text: c.periodText, soldOut: false };
}

/** ⑩ 테마 추천: 운영자가 만든 테마마다 한 줄 */
function ThemesSection() {
  const item = 'flex-none w-[128px] md:w-[160px] lg:w-[calc((100%-100px)/6)]';
  return (
    <section className={cx(SECTION, 'gap-5 md:gap-6 lg:gap-7')} aria-labelledby="h-theme">
      <h2 className={cx('t-xl', GUTTER)} id="h-theme">
        테마 추천
      </h2>
      {THEMES.map((th) => (
        <section key={th.id} className="col gap-3 lg:gap-3.5" aria-labelledby={`h-${th.id}`}>
          <h3 className={cx('t-lg', GUTTER)} id={`h-${th.id}`}>
            {th.name}
          </h3>
          <div className="relative">
            <ul id={`rail-${th.id}`} className={cx(RAIL, 'lg:gap-5')}>
              {th.cards.map((c) => {
                const s = themeSub(c);
                return (
                  <li key={c.id} className={item}>
                    <article>
                      <Link className="col" href={c.href} style={{ gap: 8, color: 'inherit' }}>
                        <ProductionPoster
                          art={c.art}
                          label={`${c.title} 포스터`}
                          kicker={c.kicker}
                          title={c.posterTitle}
                          kickerClassName="max-md:hidden"
                          titleClassName="text-base leading-[18px] md:text-[22px] md:leading-6"
                        />
                        <h4 className="t-sm fw-b">{c.title}</h4>
                        <p className={cx('t-xs muted', s.soldOut && 'row')} style={s.soldOut ? { gap: 6 } : undefined}>
                          {s.text}
                          {s.soldOut ? <span className="badge badge-danger">매진</span> : null}
                          {!s.soldOut && c.status !== 'upcoming' ? <span className="hidden lg:inline"> · {c.venue}</span> : null}
                        </p>
                      </Link>
                    </article>
                  </li>
                );
              })}
            </ul>
            <RailNextButton targetId={`rail-${th.id}`} label={`${th.name} 다음 공연 보기`} top={96} />
          </div>
        </section>
      ))}
    </section>
  );
}

function ThemesSkeleton() {
  return (
    <section className={cx(SECTION, 'gap-3.5 lg:gap-5')} aria-labelledby="h-theme-l">
      <h2 className={cx('t-xl', GUTTER)} id="h-theme-l">
        테마 추천
      </h2>
      <span className={cx('skel mx-4 md:mx-6 lg:mx-8')} style={{ height: 20, width: '40%' }} />
      <ul className={cx(RAIL, 'overflow-hidden lg:gap-5')} aria-busy="true" aria-label="테마를 불러오는 중">
        {[0, 1, 2, 3, 4, 5].map((k) => (
          <li key={k} className="col w-[128px] flex-none md:w-[160px] lg:w-[calc((100%-100px)/6)]" style={{ gap: 8 }}>
            <span className="skel" style={{ aspectRatio: '3/4' }} />
            <span className="skel" style={{ height: 16, width: '80%' }} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** ⑪ 공연장(CMP-002 venue, 원형 이니셜) → 공연장 필터를 연 검색 */
function VenuesSection() {
  return (
    <section className={cx(SECTION, 'gap-3 md:gap-3.5 lg:gap-4')} aria-labelledby="h-venue">
      <SectionHead id="h-venue" title="공연장" />
      <ul className={cx(RAIL, 'items-start gap-4 lg:gap-7')}>
        {HOME_VENUES.map((ven) => (
          <li key={ven.id} className="flex-none">
            <Link className="col w-[72px] items-center gap-2 lg:w-24 lg:gap-2.5" href={ven.href} style={{ color: 'inherit' }}>
              <span
                className="center t-lg h-16 w-16 rounded-full lg:h-20 lg:w-20"
                aria-hidden="true"
                style={{ background: 'var(--primary-subtle)', color: 'var(--link)' }}
              >
                {ven.initial}
              </span>
              <span className="t-xs fw-m text-center lg:text-sm lg:leading-[19px]">{ven.name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
