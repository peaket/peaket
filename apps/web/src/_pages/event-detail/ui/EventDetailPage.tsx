// SCR-002 공연 상세(d5 §5.2, d3 SCR-002 행, 캔버스 보드 SCR-002-m·t·d를 한 페이지 반응형으로 합쳤다). 주소의 id는 회차다.
// 휴대폰: 히어로(포스터·공연명·회차·오픈·등급) → 섹션 바로가기 → 공연 정보 → 상세정보 → 판매 조건 → 장소 → 후기 → 판매자와 안내 → 아래 고정 예매 띠.
// 태블릿(md): 히어로가 포스터 240 + 오른쪽 정보 두 칸. 데스크톱(lg): 2단 — 왼쪽 본문 8열, 오른쪽 고정 예매 패널 4열.
// 법정 고지(판매 조건 ⑤·판매자 줄 ⑩)는 모달 속에만 숨기지 않고 본문에 늘 보인다.
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { resolvePreviewState, resolvePreviewTheme } from '@peaket/ds/Preview';
import { ME } from '@/entities/me';
import { getPerformance, listPerformances } from '@/entities/performance';
import { getProduction, ProductionPoster, SEAT_MODE_LABEL, SORT_MODE_LABEL } from '@/entities/production';
import { getSeller } from '@/entities/seller';
import { getVenue } from '@/entities/venue';
import { CopyTextButton, ShareButton } from '@/features/copy-share';
import { VerifyIdentityButton } from '@/features/identity-verify';
import { LikeToggle } from '@/features/like-production';
import { OpenAlertProvider } from '@/features/open-alert';
import { queueRoomHref } from '@/shared/config/origins';
import { searchHref } from '@/shared/config/genres';
import { SCR002_STATES } from '@/shared/config/screens.discovery';
import { cx } from '@/shared/lib/cx';
import type { PageProps } from '@/shared/lib/page-props';
import { PreviewSwitcher } from '@/shared/ui/PreviewSwitcher';
import { AppShell } from '@/widgets/app-shell';
import { ReviewModals } from '@/widgets/reviews';
import {
  AUTO_SEAT_NOTE,
  brokerNotice,
  DETAIL_IMAGES,
  DETAIL_TEXT,
  LEGAL_RESALE_NOTICE,
  REVIEW_SUMMARY,
  REVIEWS,
  SORT_NOTICE,
  VERIFY_PURPOSE,
} from '../model/content';
import { defaultDetailState, detailView, type CtaContext, type DetailView } from '../model/view';
import { BookingBar, BookingFacts, BookingPanelCta, PresaleBanner } from './Booking';
import { DetailCollapse, SectionTabs } from './DetailClient';
import { DetailModalsProvider, DetailModalTrigger } from './DetailModals';

type Props = PageProps<{ id: string }>;

function load(id: string) {
  const perf = getPerformance(id);
  const production = perf ? getProduction(perf.productionId) : undefined;
  if (!perf || !production) return null;
  const venue = getVenue(production.venueId);
  const seller = getSeller(production.sellerId);
  if (!venue || !seller) return null;
  return { perf, production, venue, seller };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const d = load(id);
  return { title: d ? `${d.production.title} ${d.perf.label}` : '공연 상세' };
}

/** 섹션 사이: 휴대폰·태블릿은 8px 바탕 띠, 데스크톱은 1px 선 */
const GAP = <div className="section-gap lg:h-px lg:bg-(--border)" />;
const SEC = 'col scroll-mt-14 px-4 py-7 md:px-6 lg:px-0 lg:py-9';

export async function EventDetailPage({ params, searchParams }: Props) {
  const { id } = await params;
  const d = load(id);
  if (!d) notFound();
  const { perf, production, venue, seller } = d;
  const sp = await searchParams;
  const state = resolvePreviewState(sp, SCR002_STATES, defaultDetailState(production));
  const dark = resolvePreviewTheme(sp) === 'dark';
  const v = detailView(state, production);
  const path = `/events/${perf.id}`;
  const loginHref = `/login?next=${encodeURIComponent(path)}`;
  const other = listPerformances(production.id).find((r) => r.id !== perf.id);
  const ctx: CtaContext = {
    kind: v.cta,
    title: production.title,
    perf,
    production,
    queueHref: queueRoomHref(perf.id),
    loginHref,
    otherRoundHref: other ? `/events/${other.id}` : searchHref.genre(production.genre),
    appealHref: '/my/appeals/apl-0001',
  };
  const sort = SORT_NOTICE[v.sortMode];
  const liked = !v.guest && ME.likedProductionIds.includes(production.id);
  const tabs = [
    { id: 'sec-info', label: '공연 정보' },
    ...(v.hasDetail ? [{ id: 'sec-detail', label: '상세정보' }] : []),
    { id: 'sec-cond', label: '판매 조건' },
    { id: 'sec-venue', label: '장소' },
    { id: 'sec-review', label: '후기' },
  ];

  return (
    <AppShell
      variant="default"
      dark={dark}
      guest={v.guest}
      bottomBar={
        v.body ? (
          <OpenAlertProvider guest={v.guest} loginHref={loginHref}>
            <BookingBar ctx={ctx} />
          </OpenAlertProvider>
        ) : null
      }
    >
      <OpenAlertProvider guest={v.guest} loginHref={loginHref}>
        <DetailModalsProvider initial={v.modal} seller={seller} sortText={sort.body} perPerson={production.perPerson} loginHref={loginHref}>
          <main className="page-main pb-6 lg:pb-0" id="main" tabIndex={-1}>
            {v.body ? (
              <div className="mx-auto w-full max-w-[1280px] lg:grid lg:grid-cols-12 lg:items-start lg:gap-x-6 lg:px-8 lg:pt-8 lg:pb-16">
                <div className="col min-w-0 lg:col-span-8">
                  {v.showHero ? <Hero view={v} d={d} liked={liked} /> : <h1 className="sr-only">{production.title}</h1>}
                  <SectionTabs items={tabs} initial={v.stuck ? 'sec-cond' : 'sec-info'} stuck={v.stuck} />

                  {v.showHero ? (
                    <>
                      <InfoSection view={v} sellerName={seller.name} sort={sort} auto={production.seatMode === 'AUTO'} />
                      {GAP}
                      {v.hasDetail ? (
                        <>
                          <DetailSection view={v} productionId={production.id} title={production.title} />
                          {GAP}
                        </>
                      ) : null}
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
                          { icon: 'ic-ticket', text: `1인 ${production.perPerson}매` },
                          { icon: 'ic-ban', text: production.reentry ? '재입장 가능' : '재입장 불가' },
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
                            공연 시작 2시간 전과 입장 시작 중 이른 때 · 이 회차는 <span className="num">{perf.transferDeadlineText}</span>
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
                      href={`/events/${perf.id}/shuffle-proof`}
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
                          <strong className="t-md fw-b">{venue.name}</strong>
                        </div>
                        <div className="row between gap-2">
                          <span className="t-sm muted" id="venue-addr">
                            {venue.address}
                          </span>
                          <CopyTextButton text={venue.address} label="주소 복사" describedBy="venue-addr" done="주소를 복사했습니다" className="md:hidden" />
                        </div>
                        <Link className="link-more md:hidden" href={searchHref.venue(venue.id)}>
                          이 공연장의 다른 공연
                          <i className="ic ic-chevron-right" aria-hidden="true" />
                        </Link>
                      </div>
                      <CopyTextButton text={venue.address} label="주소 복사" describedBy="venue-addr" done="주소를 복사했습니다" className="hidden md:inline-flex" />
                    </div>
                    <Link className="link-more hidden self-start md:inline-flex" href={searchHref.venue(venue.id)}>
                      이 공연장의 다른 공연
                      <i className="ic ic-chevron-right" aria-hidden="true" />
                    </Link>
                  </section>
                  {GAP}

                  <ReviewSection view={v} path={path} />
                  {GAP}

                  <section className={cx(SEC, 'gap-4 pb-2 lg:pb-0')} aria-label="판매자와 안내">
                    <LegalBanner icon="ic-building">{brokerNotice(seller.name)}</LegalBanner>
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
                  <ReviewModals eventId={perf.id} searchParams={sp} guest={v.guest} />{/* SCR-016 후기 전체·쓰기·신고 모달(?reviews=all · ?review=new · ?report=) */}
                </div>

                <aside className="hidden lg:col-span-4 lg:sticky lg:top-6 lg:block" aria-label="회차와 예매">
                  <div className="card col" style={{ padding: 20, gap: 18, boxShadow: 'var(--shadow-sm)' }}>
                    <BookingFacts prefix="as" view={v} production={production} perf={perf} dividers />
                    {v.presaleIn ? <PresaleBanner sellerName={seller.name} /> : null}
                    <BookingPanelCta ctx={ctx} />
                  </div>
                </aside>
              </div>
            ) : v.unpublished ? (
              <div className="state" style={{ padding: '120px 24px 160px' }}>
                <span className="state-icon">
                  <i className="ic ic-lock" aria-hidden="true" />
                </span>
                <h1 className="t-lg">공개 전인 공연입니다</h1>
              </div>
            ) : (
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
            )}
          </main>
        </DetailModalsProvider>
      </OpenAlertProvider>
      <PreviewSwitcher path={path} states={SCR002_STATES} current={state} keep={{ theme: dark ? 'dark' : undefined }} />
    </AppShell>
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

type Loaded = NonNullable<ReturnType<typeof load>>;

/** ① 히어로: 포스터 · 공연명 · ⑫ 찜·공유 · 장소·시간·연령 · 배지 · ★ 후기. 휴대폰·태블릿은 ⑪ 회차·오픈·등급도 여기 */
function Hero({ view, d, liked }: { view: DetailView; d: Loaded; liked: boolean }) {
  const { production: p, perf, venue } = d;
  const posterLabel = `${p.title} 포스터`;
  return (
    <div className="md:grid md:grid-cols-[240px_minmax(0,1fr)] md:items-start md:gap-7 md:px-6 md:py-7 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-8 lg:p-0 lg:pb-8">
      <div className="center px-4 py-6 md:hidden" style={{ background: 'var(--surface-muted)' }}>
        <ProductionPoster art={p.poster.art} label={posterLabel} kicker={p.poster.kicker} title={p.poster.title} sub={p.poster.sub} style={{ width: 192 }} />
      </div>
      <ProductionPoster
        art={p.poster.art}
        size="lg"
        label={posterLabel}
        kicker={p.poster.kicker}
        title={p.poster.title}
        sub={p.poster.sub}
        decorative
        className="hidden w-[240px] md:flex lg:w-[220px]"
      />
      <div className="col min-w-0 md:gap-5 lg:gap-2.5 lg:pt-2">
        <div className="col gap-2 px-4 pt-5 md:p-0 lg:gap-2.5">
          <div className="row items-start gap-1.5 lg:order-2">
            <h1 className="t-xl grow md:text-[32px] md:leading-[42px] md:tracking-[-0.01em]" id="ev-title">
              {p.title}
            </h1>
            <LikeToggle variant="icon" defaultPressed={liked} guest={view.guest} className="lg:hidden" />
            <ShareButton title={p.title} variant="icon" className="lg:hidden" />
          </div>
          <p className="t-sm muted md:text-base md:leading-[22px] lg:order-3">
            {venue.name} · {p.durationText} · {p.ageText}
          </p>
          <div className="row wrap lg:order-1" style={{ gap: 6 }}>
            <span className="badge badge-primary">{SORT_MODE_LABEL[view.sortMode]}</span>
            <span className="badge">{SEAT_MODE_LABEL[p.seatMode]}</span>
          </div>
          {view.hasReviews ? (
            <a className="row t-sm self-start lg:order-4" href="#sec-review" style={{ gap: 4, color: 'inherit', minHeight: 32 }}>
              <i className="ic ic-star-fill ic-16" aria-hidden="true" style={{ color: 'var(--primary)' }} />
              <span className="fw-b num">{REVIEW_SUMMARY.average}</span>
              <span className="muted">· 후기 {REVIEW_SUMMARY.count}개</span>
              <span className="sr-only">후기로 이동</span>
              <i className="ic ic-chevron-right ic-16 muted" aria-hidden="true" />
            </a>
          ) : null}
          <div className="row hidden lg:order-5 lg:flex" style={{ gap: 8, marginTop: 4 }}>
            <LikeToggle variant="outline" defaultPressed={liked} guest={view.guest} />
            <ShareButton title={p.title} variant="outline" />
          </div>
        </div>
        <div className="divider hidden md:block lg:hidden" />
        <BookingFacts prefix="in" view={view} production={p} perf={perf} className="px-4 py-6 md:p-0 lg:hidden" />
      </div>
    </div>
  );
}

/** 공연 정보: ③ 본인확인 상태와 목적 문구 · 선예매 · ② 정렬 방식 고지(선착순은 사전 사람 확인 카드와 함께) */
function InfoSection({ view, sellerName, sort, auto }: { view: DetailView; sellerName: string; sort: { title: string; body: string }; auto: boolean }) {
  return (
    <section className={cx(SEC, 'gap-4')} id="sec-info" aria-labelledby="h-info">
      <h2 className="t-lg" id="h-info">
        공연 정보
      </h2>
      {view.verified ? (
        <div className="col" style={{ gap: 4 }}>
          <div className="row" style={{ gap: 10 }}>
            <span className="t-sm fw-b">본인확인</span>
            <span className="badge badge-success">
              <i className="ic ic-check" aria-hidden="true" />
              완료
            </span>
          </div>
          <p className="t-sm muted">{VERIFY_PURPOSE}</p>
        </div>
      ) : null}
      {view.needVerify ? (
        <div className="banner banner-warning">
          <i className="ic ic-alert" aria-hidden="true" />
          <div className="banner-body col" style={{ gap: 8 }}>
            <span className="banner-title">본인확인이 필요합니다</span>
            <p id="vf-purpose">{VERIFY_PURPOSE}</p>
            {/* 누르면 본인확인 기관 창이 바로 열리고 결과는 이 화면 위 대화상자(SCR-006, account 담당) */}
            <VerifyIdentityButton className="btn btn-outline btn-sm" describedBy="vf-purpose" style={{ alignSelf: 'flex-start' }}>
              <i className="ic ic-phone" aria-hidden="true" />
              휴대폰 본인확인
            </VerifyIdentityButton>
          </div>
        </div>
      ) : null}
      {view.presaleIn ? (
        <div className="lg:hidden">
          <PresaleBanner sellerName={sellerName} />
        </div>
      ) : null}
      {view.loading ? (
        <div className="col" style={{ gap: 8 }} aria-busy="true">
          <span className="sr-only">본인확인 상태를 불러오는 중</span>
          <span className="skel" style={{ height: 22, width: 140 }} />
          <span className="skel" style={{ height: 16, width: '90%' }} />
        </div>
      ) : null}
      {view.humanCheck ? (
        <section className="card col" style={{ gap: 8, padding: '14px 16px' }} aria-labelledby="hc-h">
          <div className="row" style={{ gap: 10 }}>
            <i className="ic ic-shield tx-success" aria-hidden="true" />
            <h3 className="t-md fw-b grow" id="hc-h">
              사람 확인
            </h3>
            <span className="badge badge-success">
              <i className="ic ic-check" aria-hidden="true" />
              확인 완료
            </span>
          </div>
          <p className="t-sm muted">
            오픈 전에 확인을 마쳐 두세요. 확인은 15분 동안 유효하고 그동안 조용히 갱신됩니다 · 남은 시간 <span className="num">13:05</span>
          </p>
        </section>
      ) : null}
      <div className="banner banner-info">
        <i className="ic ic-info" aria-hidden="true" />
        <div className="banner-body">
          <span className="banner-title">{sort.title}</span>
          {sort.body}
          {auto ? ` ${AUTO_SEAT_NOTE}.` : null}
        </div>
      </div>
    </section>
  );
}

/** ⑭ 상세정보: 설명 글 + 상세 이미지(대체 텍스트). 이미지 응답이 실패하면 그 자리에 대체 텍스트를 글로 보인다 */
function DetailSection({ view, productionId, title }: { view: DetailView; productionId: string; title: string }) {
  const text =
    productionId === 'prd-lumen'
      ? DETAIL_TEXT
      : `${title}의 공연 설명 글입니다. 출연진·관람 유의사항처럼 상세 이미지에만 있는 정보도 이 글에 적습니다(파트너가 공연 등록 1단계에서 쓴 글, CMP-070).`;
  return (
    <section className={cx(SEC, 'gap-4')} id="sec-detail" aria-labelledby="h-detail">
      <h2 className="t-lg" id="h-detail">
        상세정보
      </h2>
      <DetailCollapse defaultOpen={view.detailOpen}>
        <p className="prose muted">{text}</p>
        {DETAIL_IMAGES.map((img, i) =>
          view.imageFailed && i === 1 ? (
            <p key={img.alt} className="t-sm" style={{ padding: 16, border: '1px dashed var(--border-input)', borderRadius: 'var(--r-md)' }}>
              {img.alt}
            </p>
          ) : (
            <div
              key={img.alt}
              className="card-flat col center"
              role="img"
              aria-label={`상세 이미지 ${i + 1}: ${img.alt}`}
              style={{ height: img.height, gap: 8, padding: 16, textAlign: 'center' }}
            >
              <i className="ic ic-image ic-32 muted" aria-hidden="true" />
              <span className="t-sm fw-b muted">
                상세 이미지 {i + 1} / {DETAIL_IMAGES.length}
              </span>
              <span className="t-xs muted">{[img.note, `대체 텍스트: ${img.alt}`].filter(Boolean).join(' · ')}</span>
            </div>
          ),
        )}
      </DetailCollapse>
    </section>
  );
}

function Stars({ n, size = 16 }: { n: number; size?: number }) {
  return (
    <span className="row" style={{ gap: 1 }} aria-hidden="true">
      {[1, 2, 3, 4, 5].map((k) => (
        <i
          key={k}
          className={`ic ${k <= n ? 'ic-star-fill' : 'ic-star'}`}
          style={{ width: size, height: size, color: k <= n ? 'var(--primary)' : 'var(--text-disabled)' }}
        />
      ))}
    </span>
  );
}

/** ⑨ 후기: 평균 별점·후기 수 · 최근 2개 미리보기(사진·신고) · [후기 n개 전체보기]. 모달은 SCR-016(주소 ?reviews=all 등) */
function ReviewSection({ view, path }: { view: DetailView; path: string }) {
  const write = view.guest ? (
    <DetailModalTrigger modal="revGuest" className="btn btn-outline btn-sm">
      <i className="ic ic-edit" aria-hidden="true" />
      후기 쓰기
    </DetailModalTrigger>
  ) : (
    <Link className="btn btn-outline btn-sm" href={`${path}?review=new`} scroll={false} aria-haspopup="dialog">
      <i className="ic ic-edit" aria-hidden="true" />
      후기 쓰기
    </Link>
  );
  return (
    <section className={cx(SEC, 'gap-4')} id="sec-review" aria-labelledby="h-review">
      <div className="section-title">
        <h2 id="h-review">후기</h2>
        {write}
      </div>
      {view.hasReviews ? (
        <>
          <div className="row" style={{ gap: 8 }}>
            <Stars n={5} />
            <strong className="t-lg num">{REVIEW_SUMMARY.average}</strong>
            <span className="t-sm muted">후기 {REVIEW_SUMMARY.count}개</span>
            <span className="sr-only">평균 별점 5점 만점에 {REVIEW_SUMMARY.average}점</span>
          </div>
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4" aria-label={`최근 후기 ${REVIEWS.length}개`}>
            {REVIEWS.map((r) => (
              <li key={r.id}>
                <article className="card col h-full gap-2 p-4 lg:p-[18px]">
                  <div className="row wrap" style={{ gap: '4px 8px' }}>
                    <strong className="t-sm fw-b">{r.author}</strong>
                    <span className="t-xs muted">{r.watched}</span>
                    <span className="t-xs muted num">{r.written}</span>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <Stars n={r.stars} />
                    <span className="t-xs fw-b">5점 만점에 {r.stars}점</span>
                  </div>
                  <p className="t-sm grow line-clamp-3">{r.body}</p>
                  <ul className="row" style={{ gap: 8 }} aria-label={`${r.author}의 후기 사진 ${r.photos}장`}>
                    {Array.from({ length: r.photos }, (_, k) => (
                      <li key={k}>
                        <Link
                          className="center h-[72px] w-[72px] rounded-(--r-md)"
                          href={`${path}?reviews=all&review=${r.id}&photo=${k + 1}`}
                          scroll={false}
                          aria-haspopup="dialog"
                          aria-label={`${r.author}의 후기 사진 ${k + 1}/${r.photos} 크게 보기`}
                          style={{ background: 'var(--fill-weak)', color: 'var(--text-muted)' }}
                        >
                          <i className="ic ic-image ic-24" aria-hidden="true" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                  <Link
                    className="btn btn-ghost btn-sm self-start"
                    href={`${path}?report=${r.id}`}
                    scroll={false}
                    aria-haspopup="dialog"
                    aria-label={`${r.author}의 후기 신고, 게시물 ${r.id}`}
                    style={{ marginLeft: -12 }}
                  >
                    <i className="ic ic-flag" aria-hidden="true" />
                    신고
                  </Link>
                </article>
              </li>
            ))}
          </ul>
          <Link
            className="btn btn-secondary btn-lg btn-block lg:inline-flex lg:w-auto lg:min-w-[360px] lg:self-center"
            href={`${path}?reviews=all`}
            scroll={false}
            aria-haspopup="dialog"
          >
            후기 {REVIEW_SUMMARY.count}개 전체보기
          </Link>
        </>
      ) : (
        <div className="state card-flat" style={{ padding: '32px 16px' }}>
          <span className="state-icon">
            <i className="ic ic-star" aria-hidden="true" />
          </span>
          <p className="t-md fw-b">아직 후기가 없습니다</p>
        </div>
      )}
    </section>
  );
}
