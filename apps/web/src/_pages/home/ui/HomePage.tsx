// SCR-001 홈(d5 §5.1, d3 SCR-001 행, 캔버스 보드 SCR-001-m·t·d를 한 페이지 반응형으로 합쳤다).
// 섹션: 배너 슬라이드 → 장르 바로가기 → 오픈 예정 → 찜한 공연(로그인) → 장르별 랭킹 → 지금 판매 중 → 굿즈 스토어 띠 → 테마 추천 → 공연장.
// 휴대폰 먼저, md 768(태블릿)·lg 1280(데스크톱, 본문 최대 1280에 바깥 여백 32 = 1216)에서 바뀐다.
// 데이터(ADR-0199 결정 3, BUILD_ORDER HOT-300): 홈 피드는 서버가 빌드·ISR 때 받는다(loadHome, 요청 값을 읽지 않아 빌드 때 그려진다).
// 랭킹 파일·찜·알림 상태는 브라우저가 따로 받는다. 비어 있는 섹션은 숨긴다(오픈 예정만 '예정된 공연이 없습니다'를 보인다).
import Link from 'next/link';
import { formatWon } from '@/entities/production';
import { HOME_GENRE_TILES, searchHref } from '@/shared/config/genres';
import { cx } from '@/shared/lib/cx';
import { PicturePoster } from '@/shared/ui/PicturePoster';
import { AppShell } from '@/widgets/app-shell';
import { loadHome } from '../api/load-home';
import type { HomeCard, HomePlace, HomeTheme } from '../model/feed';
import { BannerCarousel } from './BannerCarousel';
import { HomeAlertToggle, HomeOpenAlertProvider, HomePersonalProvider, LikesSection } from './HomePersonal';
import { RailNextButton } from './RailNextButton';
import { RankingSection } from './RankingSection';

/** 가로 스크롤 카드 줄(CMP-071 rail): 휴대폰·태블릿은 손가락으로 넘기고, 데스크톱은 같은 줄을 열 수에 맞춰 나눈다.
 *  relative: 안의 sr-only(absolute) 글이 줄 밖 조상을 기준으로 잡혀 페이지 가로 스크롤을 만들지 않게 한다 */
const RAIL = 'relative row items-stretch gap-3 overflow-x-auto px-4 [scrollbar-width:none] md:px-6 lg:px-8';
/** 섹션 머리·본문의 가로 여백(데스크톱은 1280 상자 안 32) */
const GUTTER = 'px-4 md:px-6 lg:px-8';
const SECTION = 'col mx-auto w-full max-w-[1280px]';
const H2 = 'lg:text-[22px] lg:leading-[30px]';
/** 포스터 비율(세로형 3:4) */
const POSTER = { width: 300, height: 400 } as const;

export async function HomePage() {
  const home = await loadHome();
  const alertEventIds = home.upcoming.flatMap((c) => (c.nextOpenEventId ? [c.nextOpenEventId] : []));

  return (
    // 캐시 화면이라 셸은 비로그인 모양으로 그린다(서버는 쿠키로 로그인 여부를 정하지 않는다). 로그인 표시는 HOT-320이 화면 스크립트로 바꾼다
    <AppShell variant="default" current="home" guest>
      <HomePersonalProvider alertEventIds={alertEventIds}>
        <HomeOpenAlertProvider>
          <main className="page-main gap-8 pt-3 pb-10 md:gap-10 md:pt-4 md:pb-12 lg:gap-12 lg:pt-6 lg:pb-16" id="main" tabIndex={-1}>
            <h1 className="sr-only">PEAKET 홈</h1>
            {home.banners.length > 0 ? <BannerCarousel slides={home.banners} /> : null}
            <GenreTiles />
            <UpcomingSection cards={home.upcoming} />
            <LikesSection sectionClass={SECTION} railClass={RAIL} headClass={GUTTER} />
            <RankingSection />
            {home.onSale.length > 0 ? <OnSaleSection cards={home.onSale} /> : null}
            <GoodsBand />
            {home.themes.length > 0 ? <ThemesSection themes={home.themes} /> : null}
            {home.places.length > 0 ? <VenuesSection places={home.places} /> : null}
          </main>
        </HomeOpenAlertProvider>
      </HomePersonalProvider>
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
function UpcomingSection({ cards }: { cards: readonly HomeCard[] }) {
  const item = 'flex-none w-[148px] md:w-[200px] lg:w-[calc((100%-96px)/5)]';
  return (
    <section className={cx(SECTION, 'gap-3 md:gap-3.5 lg:gap-4')} aria-labelledby="h-open">
      <SectionHead id="h-open" title="오픈 예정" more={{ href: searchHref.upcoming(), label: '전체보기' }} />
      {cards.length > 0 ? (
        <div className="relative">
          <ul id="rail-open" className={cx(RAIL, 'lg:gap-6')}>
            {cards.map((c) => (
              <li key={c.id} className={item}>
                <article className="relative col h-full gap-2.5 lg:gap-3">
                  <PicturePoster src={c.posterUrl} alt={c.posterAlt} {...POSTER} sizes="(min-width: 1280px) 220px, (min-width: 768px) 200px, 148px" className="rounded-(--r-md)" fallbackLabel={c.title} />
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1">
                    <span className="t-sm fw-b num self-center lg:text-base lg:leading-[22px]">{c.openText ? `${c.openText} 오픈` : '오픈 예정'}</span>
                    {c.nextOpenEventId ? <HomeAlertToggle title={c.title} eventId={c.nextOpenEventId} className="z-[1]" /> : <span />}
                    <h3 className="t-sm col-span-2 line-clamp-2">
                      {/* 카드 링크는 공연명 하나. 누르는 영역만 카드 전체로 넓히고(가상 요소), 종 토글은 그 위에 따로 둔다 */}
                      <Link href={c.href} className="after:absolute after:inset-0 after:content-['']" style={{ color: 'inherit' }}>
                        {c.title}
                      </Link>
                    </h3>
                    {c.badge ? (
                      <div className="row wrap col-span-2" style={{ gap: 4 }}>
                        <span className={c.badge.tone === 'primary' ? 'badge badge-primary' : 'badge'}>{c.badge.text}</span>
                      </div>
                    ) : null}
                  </div>
                </article>
              </li>
            ))}
          </ul>
          <RailNextButton targetId="rail-open" label="오픈 예정 다음 공연 보기" />
        </div>
      ) : (
        <div className={GUTTER}>
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
      )}
    </section>
  );
}

/** ⑨ 지금 판매 중(CMP-072 horizontal): 휴대폰 1열 · 태블릿 2열 · 데스크톱 3열. 남은 기간은 글자로만 */
function OnSaleSection({ cards }: { cards: readonly HomeCard[] }) {
  const grid = cx('grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4 lg:grid-cols-3 lg:gap-6', GUTTER);
  return (
    <section className={cx(SECTION, 'gap-3 md:gap-3.5 lg:gap-4')} aria-labelledby="h-onsale">
      <SectionHead id="h-onsale" title="지금 판매 중" />
      <ul className={grid}>
        {cards.map((c) => (
          <li key={c.id}>
            <article className="h-full">
              <Link className="card row h-full items-start gap-3.5 p-3 lg:gap-4 lg:p-4" href={c.href} style={{ color: 'inherit' }}>
                <PicturePoster src={c.posterUrl} alt={c.posterAlt} {...POSTER} sizes="(min-width: 1280px) 104px, 76px" className="w-[76px] flex-none rounded-(--r-sm) lg:w-[104px]" />
                <div className="col grow gap-1 lg:gap-1.5">
                  <p className="row" style={{ gap: 8 }}>
                    <span className="badge badge-success">판매 중</span>
                    {c.daysLeftText ? <span className="t-sm muted">{c.daysLeftText}</span> : null}
                  </p>
                  <h3 className="t-md fw-b">{c.title}</h3>
                  <p className="t-sm muted">
                    {c.venue}
                    {c.periodText ? <span className="lg:hidden"> · {c.periodText}</span> : null}
                  </p>
                  {c.periodText ? <p className="t-sm muted hidden lg:block">{c.periodText}</p> : null}
                  {typeof c.minPrice === 'number' ? <p className="t-md fw-b num lg:mt-0.5">{formatWon(c.minPrice)}부터</p> : null}
                </div>
              </Link>
            </article>
          </li>
        ))}
      </ul>
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
  if (c.status === 'upcoming') return { text: c.openText ? `${c.openText} 오픈` : '오픈 예정', soldOut: false };
  if (c.status === 'sold_out') return { text: c.periodText, soldOut: true };
  return { text: c.periodText, soldOut: false };
}

/** ⑩ 테마 추천: 운영자가 만든 테마마다 한 줄 */
function ThemesSection({ themes }: { themes: readonly HomeTheme[] }) {
  const item = 'flex-none w-[128px] md:w-[160px] lg:w-[calc((100%-100px)/6)]';
  return (
    <section className={cx(SECTION, 'gap-5 md:gap-6 lg:gap-7')} aria-labelledby="h-theme">
      <h2 className={cx('t-xl', GUTTER)} id="h-theme">
        테마 추천
      </h2>
      {themes.map((th, k) => (
        <section key={th.id} className="col gap-3 lg:gap-3.5" aria-labelledby={`h-theme-${k}`}>
          <h3 className={cx('t-lg', GUTTER)} id={`h-theme-${k}`}>
            {th.name}
          </h3>
          <div className="relative">
            <ul id={`rail-theme-${k}`} className={cx(RAIL, 'lg:gap-5')}>
              {th.cards.map((c) => {
                const s = themeSub(c);
                return (
                  <li key={c.id} className={item}>
                    <article>
                      <Link className="col" href={c.href} style={{ gap: 8, color: 'inherit' }}>
                        <PicturePoster src={c.posterUrl} alt={c.posterAlt} {...POSTER} sizes="(min-width: 1280px) 180px, (min-width: 768px) 160px, 128px" className="rounded-(--r-md)" fallbackLabel={c.title} />
                        <h4 className="t-sm fw-b">{c.title}</h4>
                        <p className={cx('t-xs muted', s.soldOut && 'row')} style={s.soldOut ? { gap: 6 } : undefined}>
                          {s.text}
                          {s.soldOut ? <span className="badge badge-danger">매진</span> : null}
                          {!s.soldOut && c.status !== 'upcoming' && c.venue ? <span className="hidden lg:inline"> · {c.venue}</span> : null}
                        </p>
                      </Link>
                    </article>
                  </li>
                );
              })}
            </ul>
            <RailNextButton targetId={`rail-theme-${k}`} label={`${th.name} 다음 공연 보기`} top={96} />
          </div>
        </section>
      ))}
    </section>
  );
}

/** ⑪ 공연장(CMP-002 venue, 원형 이니셜) → 공연장 필터를 연 검색 */
function VenuesSection({ places }: { places: readonly HomePlace[] }) {
  return (
    <section className={cx(SECTION, 'gap-3 md:gap-3.5 lg:gap-4')} aria-labelledby="h-venue">
      <SectionHead id="h-venue" title="공연장" />
      <ul className={cx(RAIL, 'items-start gap-4 lg:gap-7')}>
        {places.map((ven) => (
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
