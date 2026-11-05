// SCR-002 공연 상세(d5 §5.2, d3 SCR-002 행, 캔버스 보드 SCR-002-m·t·d를 한 페이지 반응형으로 합쳤다). 주소의 id는 회차다.
// 휴대폰: 히어로(포스터·공연명·회차·오픈·등급) → 섹션 바로가기 → 공연 정보 → 상세정보 → 판매 조건 → 장소 → 후기 → 판매자와 안내 → 아래 고정 예매 띠.
// 태블릿(md): 히어로가 포스터 240 + 오른쪽 정보 두 칸. 데스크톱(lg): 2단 — 왼쪽 본문 8열, 오른쪽 고정 예매 패널 4열.
// 법정 고지(판매 조건 ⑤·판매자 줄 ⑩)는 모달 속에만 숨기지 않고 본문에 늘 보인다.
// 데이터(ADR-0200, BUILD_ORDER HOT-311): 정적 부분은 서버가 ISR로 받는다(loadEvent, 요청 값을 읽지 않는다). 예매 버튼·등급 배지는 브라우저가 시각으로
// 고르고(Booking), 찜·알림(DetailPersonal)·후기 요약(DetailReviews)은 브라우저가 따로 받는다. 판매 중지는 안내와 상태 표시(410, ADR-0201)만 그린다.
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { SEAT_MODE_LABEL, SORT_MODE_LABEL } from '@/entities/production';
import { CopyTextButton, ShareButton } from '@/features/copy-share';
import { GENRES, searchHref } from '@/shared/config/genres';
import { SITE_ORIGIN } from '@/shared/config/origins';
import { cx } from '@/shared/lib/cx';
import { derivativeUrl } from '@/shared/lib/image-loader';
import { PicturePoster } from '@/shared/ui/PicturePoster';
import { AppShell } from '@/widgets/app-shell';
import { loadEvent, popularEventIds } from '../api/load-event';
import { AUTO_SEAT_NOTE, brokerNotice, LEGAL_RESALE_NOTICE, SORT_NOTICE } from '../model/content';
import { jsonLdText, offerAvailability, type EventDetail } from '../model/detail';
import { BookingBar, BookingFacts, BookingPanelCta, BookingPreverifyCard, BookingProvider, type BookingData } from './Booking';
import { DetailCollapse, DetailImage, SectionTabs, WishButton } from './DetailClient';
import { DetailModalsProvider, DetailModalTrigger } from './DetailModals';
import { DetailPersonalProvider } from './DetailPersonal';
import { PreverifyProvider } from './Preverify';
import { DetailReviewModals, HeroRating, ReviewSection, ReviewSummaryProvider } from './DetailReviews';
import { VerifyStatusRow } from './DetailVerify';
import { VerifyReturnResume } from './VerifyReturnResume';

type Props = { params: Promise<{ id: string }> };

export async function generateStaticParams(): Promise<{ id: string }[]> {
  return (await popularEventIds()).map((id) => ({ id }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const r = await loadEvent(id);
  if (r.kind === 'suspended') return { title: '판매가 중지된 공연입니다', robots: { index: false, follow: false } };
  if (r.kind === 'missing') return { title: '페이지를 찾을 수 없습니다', robots: { index: false, follow: false } };
  const d = r.detail;
  // 회차마다 자기 주소가 정규 주소다(ADR-0153). 제목에 회차 일시를 넣어 같은 공연의 회차끼리 비슷한 페이지로 묶이지 않게 한다
  return { title: `${d.title} ${d.roundLabel}`, alternates: { canonical: `${SITE_ORIGIN}/events/${d.eventId}` } };
}

/** 섹션 사이: 휴대폰·태블릿은 8px 바탕 띠, 데스크톱은 1px 선 */
const GAP = <div className="section-gap lg:h-px lg:bg-(--border)" />;
const SEC = 'col scroll-mt-14 px-4 py-7 md:px-6 lg:px-0 lg:py-9';

export async function EventDetailPage({ params }: Props) {
  const { id } = await params;
  const r = await loadEvent(id);
  if (r.kind === 'missing') notFound();
  if (r.kind === 'suspended') return <SuspendedNotice />;
  const d = r.detail;
  const path = `/events/${d.eventId}`;
  const loginHref = `/login?next=${encodeURIComponent(path)}`;
  const sort = SORT_NOTICE[d.sortMode];
  // 계약의 장르는 정본 이름(한글)이고 검색 주소는 영문 키다(docs/features/search.md §5.4)
  const genreKey = GENRES.find((g) => g.label === d.genre)?.key;
  const booking: BookingData = {
    eventId: d.eventId,
    title: d.title,
    roundLabel: d.roundLabel,
    status: d.status,
    openAtMs: d.openAtMs,
    ...(d.lobbyOpensAtMs !== undefined ? { lobbyOpensAtMs: d.lobbyOpensAtMs } : {}),
    saleEndsAtMs: d.saleEndsAtMs,
    openText: d.openText,
    ...(d.lobbyText ? { lobbyText: d.lobbyText } : {}),
    openTimeText: d.openTimeText,
    rounds: d.rounds,
    tiers: d.tiers,
    otherRoundFallbackHref: genreKey ? searchHref.genre(genreKey) : '/search',
    loginHref,
    signupHref: `/signup/consent?next=${encodeURIComponent(path)}`,
  };
  const tabs = [
    { id: 'sec-info', label: '공연 정보' },
    ...(d.hasDetail ? [{ id: 'sec-detail', label: '상세정보' }] : []),
    { id: 'sec-cond', label: '판매 조건' },
    { id: 'sec-venue', label: '장소' },
    { id: 'sec-review', label: '후기' },
  ];

  return (
    // 캐시 화면이라 서버는 쿠키로 로그인 여부를 정하지 않는다. 셸 머리는 화면 스크립트가 팬 계정 요약으로 고른다(ADR-0202 결정 2)
    <DetailPersonalProvider eventId={d.eventId} productionId={d.productionId} loginHref={loginHref}>
      <BookingProvider data={booking}>
        <PreverifyProvider eventId={d.eventId} loginHref={loginHref}>
        <ReviewSummaryProvider eventId={d.eventId}>
          <AppShell variant="default" bottomBar={<BookingBar data={booking} />}>
            <EventJsonLd d={d} atMs={r.fetchedAtMs} />
            <VerifyReturnResume loginHref={loginHref} />
            <DetailModalsProvider initial={null} sellerName={d.sellerName} seller={d.seller} sortText={sort.body} perPerson={d.perPersonLimit} loginHref={loginHref}>
              <main className="page-main pb-6 lg:pb-0" id="main" tabIndex={-1}>
                <div className="mx-auto w-full max-w-[1280px] lg:grid lg:grid-cols-12 lg:items-start lg:gap-x-6 lg:px-8 lg:pt-8 lg:pb-16">
                  <div className="col min-w-0 lg:col-span-8">
                    <Hero d={d} booking={booking} loginHref={loginHref} />
                    <SectionTabs items={tabs} initial="sec-info" />

                    <section className={cx(SEC, 'gap-4')} id="sec-info" aria-labelledby="h-info">
                      <h2 className="t-lg" id="h-info">
                        공연 정보
                      </h2>
                      <div data-verify-scope>
                        <VerifyStatusRow loginHref={loginHref} />
                      </div>
                      {d.artists.length > 0 ? (
                        <p className="t-sm">
                          <span className="fw-b">출연</span> <span className="muted">{d.artists.join(', ')}</span>
                        </p>
                      ) : null}
                      <div className="banner banner-info">
                        <i className="ic ic-info" aria-hidden="true" />
                        <div className="banner-body">
                          <span className="banner-title">{sort.title}</span>
                          {sort.body}
                          {d.seatMode === 'AUTO' ? ` ${AUTO_SEAT_NOTE}.` : null}
                        </div>
                      </div>
                    </section>
                    {GAP}

                    {d.hasDetail ? (
                      <>
                        <section className={cx(SEC, 'gap-4')} id="sec-detail" aria-labelledby="h-detail">
                          <h2 className="t-lg" id="h-detail">
                            상세정보
                          </h2>
                          <DetailCollapse>
                            {d.description.map((p, i) => (
                              <p key={i} className="prose muted" style={{ whiteSpace: 'pre-line' }}>
                                {p}
                              </p>
                            ))}
                            {d.detailImages.map((img, i) => (
                              <DetailImage key={img.url} url={img.url} alt={img.alt} index={i} total={d.detailImages.length} />
                            ))}
                          </DetailCollapse>
                        </section>
                        {GAP}
                      </>
                    ) : null}

                    <section className={cx(SEC, 'gap-3 lg:gap-3.5')} id="sec-cond" role="region" aria-labelledby="h-cond">
                      <h2 className="t-lg" id="h-cond">
                        판매 조건
                      </h2>
                      <div className="card col gap-4 p-4 md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] md:gap-6 md:p-5">
                        <ul className="grid grid-cols-3 content-start gap-2">
                          {[
                            { icon: 'ic-user', text: '1인 1순번' },
                            { icon: 'ic-ticket', text: `1인 ${d.perPersonLimit}매` },
                            { icon: 'ic-ban', text: d.reentryAllowed ? '재입장 가능' : '재입장 불가' },
                          ].map((t) => (
                            <li key={t.text} className="card-flat col items-center gap-1.5 px-1 py-3.5 text-center lg:py-4">
                              <i className={`ic ${t.icon}`} aria-hidden="true" />
                              <span className="t-sm fw-b">{t.text}</span>
                            </li>
                          ))}
                        </ul>
                        <dl className="col" style={{ gap: 12 }}>
                          <div className="col" style={{ gap: 2 }}>
                            <dt className="t-sm fw-b">양도 마감</dt>
                            <dd className="t-sm muted">
                              공연 시작 2시간 전과 입장 시작 중 이른 때 · 이 회차는 <span className="num">{d.transferDeadlineText}</span>
                            </dd>
                          </div>
                          <div className="col" style={{ gap: 2 }}>
                            <dt className="t-sm fw-b">취소</dt>
                            <dd className="t-sm muted">
                              공연일 10일 이내 취소 시 기준에 따른 공제 후 환불{' '}
                              <DetailModalTrigger modal="refund" className="link-more" style={{ border: 0, background: 'transparent', padding: 0, cursor: 'pointer' }}>
                                자세히
                                <i className="ic ic-chevron-right" aria-hidden="true" />
                              </DetailModalTrigger>
                            </dd>
                          </div>
                        </dl>
                      </div>
                      <LegalBanner icon="ic-scale">{LEGAL_RESALE_NOTICE}</LegalBanner>
                      <Link
                        className="li border-t border-(--border) text-(--text) md:items-start md:rounded-(--r-xl) md:border md:p-[18px]"
                        href={`/events/${d.eventId}/shuffle-proof`}
                      >
                        <i className="ic ic-shield ic-24" aria-hidden="true" style={{ color: 'var(--link)' }} />
                        <span className="col grow" style={{ gap: 2 }}>
                          <span className="li-title md:font-bold">셔플 검증</span>
                          <span className="li-sub md:text-sm md:leading-[19px]">누구나 공개된 시드·비콘·참가자 목록으로 전체 순서를 다시 계산할 수 있습니다</span>
                        </span>
                        <i className="ic ic-chevron-right" aria-hidden="true" />
                      </Link>
                    </section>
                    {GAP}

                    <section className={cx(SEC, 'gap-3 lg:gap-3.5')} id="sec-venue" aria-labelledby="h-venue">
                      <h2 className="t-lg" id="h-venue">
                        장소
                      </h2>
                      <div className="card col gap-3 p-4 md:flex-row md:items-center md:gap-4 md:px-5 md:py-[18px]">
                        <i className="ic ic-pin ic-24 hidden md:inline-block" aria-hidden="true" />
                        <div className="col grow gap-3 md:gap-0.5">
                          <div className="row" style={{ gap: 8 }}>
                            <i className="ic ic-pin md:hidden" aria-hidden="true" />
                            <strong className="t-md fw-b">{d.place.name}</strong>
                          </div>
                          {d.place.address ? (
                            <div className="row between gap-2">
                              <span className="t-sm muted" id="venue-addr">
                                {d.place.address}
                              </span>
                              <CopyTextButton text={d.place.address} label="주소 복사" describedBy="venue-addr" done="주소를 복사했습니다" className="md:hidden" />
                            </div>
                          ) : null}
                          {d.place.id ? (
                            <Link className="link-more md:hidden" href={searchHref.venue(d.place.id)}>
                              이 공연장의 다른 공연
                              <i className="ic ic-chevron-right" aria-hidden="true" />
                            </Link>
                          ) : null}
                        </div>
                        {d.place.address ? (
                          <CopyTextButton text={d.place.address} label="주소 복사" describedBy="venue-addr" done="주소를 복사했습니다" className="hidden md:inline-flex" />
                        ) : null}
                      </div>
                      {d.place.id ? (
                        <Link className="link-more hidden self-start md:inline-flex" href={searchHref.venue(d.place.id)}>
                          이 공연장의 다른 공연
                          <i className="ic ic-chevron-right" aria-hidden="true" />
                        </Link>
                      ) : null}
                    </section>
                    {GAP}

                    <ReviewSection path={path} sectionClass={SEC} />
                    {GAP}

                    <section className={cx(SEC, 'gap-4 pb-2 lg:pb-0')} aria-label="판매자와 안내">
                      <LegalBanner icon="ic-building">{brokerNotice(d.sellerName)}</LegalBanner>
                      <ul style={{ borderTop: '1px solid var(--border)' }}>
                        {(
                          [
                            ['guide', '예매 안내사항'],
                            ['refund', '취소·환불 안내사항'],
                            ['seller', '판매자 정보'],
                          ] as const
                        ).map(([m, label]) => (
                          <li key={m}>
                            <DetailModalTrigger
                              modal={m}
                              className="li"
                              style={{ width: '100%', border: 0, borderBottom: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', textAlign: 'left', color: 'inherit' }}
                            >
                              <span className="li-title grow">{label}</span>
                              <i className="ic ic-chevron-right" aria-hidden="true" />
                            </DetailModalTrigger>
                          </li>
                        ))}
                      </ul>
                    </section>
                    {/* SCR-016 후기 전체·쓰기·신고 모달(?reviews=all · ?review=new · ?report=): 주소 값은 화면 스크립트가 읽는다 */}
                    <DetailReviewModals eventId={d.eventId} title={d.title} rounds={d.rounds.map((x) => ({ value: x.eventId, label: x.label }))} />
                  </div>

                  <aside className="hidden lg:col-span-4 lg:sticky lg:top-6 lg:block" aria-label="회차와 예매">
                    <div className="card col" style={{ padding: 20, gap: 18, boxShadow: 'var(--shadow-sm)' }}>
                      <BookingFacts prefix="as" data={booking} dividers />
                      <BookingPreverifyCard />
                      <BookingPanelCta data={booking} />
                    </div>
                  </aside>
                </div>
              </main>
            </DetailModalsProvider>
          </AppShell>
        </ReviewSummaryProvider>
        </PreverifyProvider>
      </BookingProvider>
    </DetailPersonalProvider>
  );
}

function LegalBanner({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div className="banner banner-legal">
      <i className={`ic ${icon}`} aria-hidden="true" />
      <div className="banner-body">
        <span className="legal-tag">법정 고지</span>
        {children}
      </div>
    </div>
  );
}

/** ① 히어로: 포스터 · 공연명 · ⑫ 찜·공유 · 장소·시간·연령 · 배지 · ★ 후기. 휴대폰·태블릿은 ⑪ 회차·오픈·등급도 여기 */
function Hero({ d, booking, loginHref }: { d: EventDetail; booking: BookingData; loginHref: string }) {
  return (
    <div className="md:grid md:grid-cols-[240px_minmax(0,1fr)] md:items-start md:gap-7 md:px-6 md:py-7 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-8 lg:p-0 lg:pb-8">
      <div className="center px-4 py-6 md:hidden" style={{ background: 'var(--surface-muted)' }}>
        <PicturePoster src={d.posterUrl} alt={d.posterAlt} width={300} height={400} sizes="192px" priority fallbackLabel={d.title} style={{ width: 192, borderRadius: 'var(--r-md)' }} />
      </div>
      <PicturePoster
        src={d.posterUrl}
        alt=""
        width={300}
        height={400}
        sizes="(min-width: 1280px) 220px, 240px"
        fallbackLabel={d.title}
        className="hidden w-[240px] md:block lg:w-[220px]"
        style={{ borderRadius: 'var(--r-md)' }}
      />
      <div className="col min-w-0 md:gap-5 lg:gap-2.5 lg:pt-2">
        <div className="col gap-2 px-4 pt-5 md:p-0 lg:gap-2.5">
          <div className="row items-start gap-1.5 lg:order-2">
            <h1 className="t-xl grow md:text-[32px] md:leading-[42px] md:tracking-[-0.01em]" id="ev-title">
              {d.title}
            </h1>
            <WishButton variant="icon" loginHref={loginHref} className="lg:hidden" />
            <ShareButton title={d.title} variant="icon" className="lg:hidden" />
          </div>
          {d.infoLine ? <p className="t-sm muted md:text-base md:leading-[22px] lg:order-3">{d.infoLine}</p> : null}
          <div className="row wrap lg:order-1" style={{ gap: 6 }}>
            <span className="badge badge-primary">{SORT_MODE_LABEL[d.sortMode]}</span>
            <span className="badge">{SEAT_MODE_LABEL[d.seatMode]}</span>
            {d.presale ? <span className="badge">선예매</span> : null}
          </div>
          <HeroRating />
          <div className="row hidden lg:order-5 lg:flex" style={{ gap: 8, marginTop: 4 }}>
            <WishButton variant="outline" loginHref={loginHref} />
            <ShareButton title={d.title} variant="outline" />
          </div>
        </div>
        <div className="divider hidden md:block lg:hidden" />
        <BookingFacts prefix="in" data={booking} className="px-4 py-6 md:p-0 lg:hidden" />
        <BookingPreverifyCard className="mx-4 mb-6 md:mx-0 lg:hidden" />
      </div>
    </div>
  );
}

/**
 * 회차 하나의 schema.org Event(ADR-0153: 회차마다 자기 주소와 Event 하나, docs/frontend.md '회차 상세의 정규 주소', HOT-311이 넘김).
 * 실행되지 않는 데이터 블록이라 CSP가 보지 않는다. `dangerouslySetInnerHTML`을 쓰지 않고(asvs/frontend.md 1.2.1) 글자 자식으로 싣는다:
 * `<`를 미리 JSON 이스케이프(역빗금 u003c)로 바꿔 스크립트 블록을 끝내지 못하게 하고, React도 `</script`를 바꿔 쓴다(2026-11-05 react-dom/server로 확인).
 */
/** atMs: 상세를 받은 시각(캐시 항목과 함께 다시 만든다, 300초). 판매 상태가 그만큼 늦을 수 있다 */
function EventJsonLd({ d, atMs }: { d: EventDetail; atMs: number }) {
  const minPrice = d.tiers.length > 0 ? Math.min(...d.tiers.map((t) => t.price)) : undefined;
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: `${d.title} ${d.roundLabel}`,
    startDate: new Date(d.startsAtMs).toISOString(),
    eventStatus:
      d.status === 'CANCELLED' ? 'https://schema.org/EventCancelled' : d.status === 'POSTPONED' ? 'https://schema.org/EventPostponed' : 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: { '@type': 'Place', name: d.place.name, ...(d.place.address ? { address: d.place.address } : {}) },
    ...(d.posterUrl ? { image: [derivativeUrl(d.posterUrl, 1280, 'webp')] } : {}),
    organizer: { '@type': 'Organization', name: d.sellerName },
    ...(d.artists.length > 0 ? { performer: d.artists.map((name) => ({ '@type': 'PerformingGroup', name })) } : {}),
    ...(minPrice !== undefined
      ? {
          offers: {
            '@type': 'Offer',
            price: minPrice,
            priceCurrency: 'KRW',
            url: `${SITE_ORIGIN}/events/${d.eventId}`,
            validFrom: new Date(d.openAtMs).toISOString(),
            availability: offerAvailability(d, atMs),
          },
        }
      : {}),
  };
  return <script type="application/ld+json">{jsonLdText(data)}</script>;
}

/** 판매 중지(d5 §5.2 '판매 중지'): CMP-046 안내만. 예매 버튼·잔여석·후기는 없고 사유는 보이지 않는다. 상태 표시로 앞 서버가 410을 단다(ADR-0201) */
function SuspendedNotice() {
  return (
    <AppShell variant="default">
      <meta name="peaket-status" content="410" />
      <main className="page-main" id="main" tabIndex={-1}>
        <div className="state" style={{ padding: '120px 24px 160px' }}>
          <span className="state-icon is-warning">
            <i className="ic ic-ban" aria-hidden="true" />
          </span>
          <span className="badge badge-danger">판매 중지</span>
          <h1 className="t-lg">판매가 중지된 공연입니다</h1>
          <p className="t-md muted" style={{ maxWidth: 440 }}>
            새 예매는 받지 않습니다. 이미 예매한 티켓은 그대로 유효하고, 취소·양도·입장도 평소 규칙대로 할 수 있습니다
          </p>
          <Link className="link-more" href="/my/tickets">
            마이 티켓
            <i className="ic ic-chevron-right" aria-hidden="true" />
          </Link>
        </div>
      </main>
    </AppShell>
  );
}
