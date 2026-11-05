'use client';
// ⑨ 후기(d5 §5.2 '관람 후기 섹션'): 같은 공연의 모든 회차 후기를 모은 평균 별점·후기 수, 최근 후기 2개 미리보기, [후기 n개 전체보기],
// 섹션 머리 오른쪽 [후기 쓰기](자격이 없어도 숨기지 않는다, POL-042). 요약은 브라우저가 공개 CDN 경로로 받는다
// (`GET /v1/events/{eventId}/review-summary`, 60초 캐시, docs/frontend.md §2.5. 상세의 정적 셸에는 싣지 않는다, ADR-0200 결정 2).
// 모달(SCR-016 후기 전체·쓰기·신고)은 주소 값으로 띄운다(widgets/reviews). api-client는 늦게 가져온다(첫 화면 JS 예산, §5.8).
import Link from 'next/link';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { ReviewSummary } from '@peaket/api-client/model';
import { cx } from '@/shared/lib/cx';
import { ReviewModalsFromUrl } from '@/widgets/reviews';
import { kstParts, parseTime } from '@/shared/lib/kst';
import { useDetailPersonal } from './DetailPersonal';
import { DetailModalTrigger } from './DetailModals';

type State = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; summary: ReviewSummary };

/** 관람 회차 '10월 25일 18:00 관람'(d5 §5.2 ⑨) */
function attendedText(ms: number): string {
  const k = kstParts(ms);
  return `${k.m}월 ${k.d}일 ${k.hh}:${k.mm} 관람`;
}

/** 쓴 날 '10/25 작성' */
function writtenText(ms: number): string {
  const k = kstParts(ms);
  return `${k.m}/${k.d} 작성`;
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

const SummaryContext = createContext<State>({ kind: 'loading' });

/** 후기 요약을 한 번 받아 히어로 별점 줄과 후기 섹션이 함께 쓴다 */
export function ReviewSummaryProvider({ eventId, children }: { eventId: string; children: ReactNode }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [{ getEventReviewSummary }, api] = await Promise.all([import('@peaket/api-client/endpoints/reviews'), import('@/shared/api')]);
        api.ensureBrowserApi();
        const r = await getEventReviewSummary(eventId);
        if (live) setState({ kind: 'ready', summary: r.data });
      } catch {
        if (live) setState({ kind: 'error' });
      }
    })();
    return () => {
      live = false;
    };
  }, [eventId]);
  return <SummaryContext.Provider value={state}>{children}</SummaryContext.Provider>;
}

const useSharedSummary = (): State => useContext(SummaryContext);

/** 히어로의 '★ 4.6 · 후기 128개' 줄(후기가 있을 때만) */
export function HeroRating() {
  const s = useSharedSummary();
  if (s.kind !== 'ready' || !s.summary.count || s.summary.averageRating == null) return null;
  return (
    <a className="row t-sm self-start lg:order-4" href="#sec-review" style={{ gap: 4, color: 'inherit', minHeight: 32 }}>
      <i className="ic ic-star-fill ic-16" aria-hidden="true" style={{ color: 'var(--primary)' }} />
      <span className="fw-b num">{s.summary.averageRating.toFixed(1)}</span>
      <span className="muted">· 후기 {s.summary.count.toLocaleString('ko-KR')}개</span>
      <span className="sr-only">후기로 이동</span>
      <i className="ic ic-chevron-right ic-16 muted" aria-hidden="true" />
    </a>
  );
}

export function ReviewSection({ path, sectionClass }: { path: string; sectionClass: string }) {
  const s = useSharedSummary();
  const { status } = useDetailPersonal();
  const guest = status === 'guest';
  const write = guest ? (
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
  let body;
  if (s.kind === 'loading') {
    body = (
      <div className="col" style={{ gap: 8 }} aria-busy="true">
        <span className="sr-only">후기를 불러오는 중</span>
        <span className="skel" style={{ height: 28, width: 180 }} />
        <span className="skel" style={{ height: 120 }} />
      </div>
    );
  } else if (s.kind === 'error') {
    body = <p className="t-sm muted">후기를 불러오지 못했습니다. 잠시 뒤 다시 열어 주세요</p>;
  } else if (!s.summary.count) {
    body = (
      <div className="state card-flat" style={{ padding: '32px 16px' }}>
        <span className="state-icon">
          <i className="ic ic-star" aria-hidden="true" />
        </span>
        <p className="t-md fw-b">아직 후기가 없습니다</p>
      </div>
    );
  } else {
    const avg = s.summary.averageRating ?? 0;
    const count = s.summary.count;
    const recent = (s.summary.recent ?? []).filter((r) => r.reviewId && r.status !== 'HIDDEN');
    body = (
      <>
        <div className="row" style={{ gap: 8 }}>
          <Stars n={Math.round(avg)} />
          <strong className="t-lg num">{avg.toFixed(1)}</strong>
          <span className="t-sm muted">후기 {count.toLocaleString('ko-KR')}개</span>
          <span className="sr-only">평균 별점 5점 만점에 {avg.toFixed(1)}점</span>
        </div>
        {recent.length > 0 ? (
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-4" aria-label={`최근 후기 ${recent.length}개`}>
            {recent.map((r) => {
              const attended = parseTime(r.attendedStartsAt);
              const written = parseTime(r.createdAt);
              const rating = r.rating ?? 0;
              const photos = r.images ?? [];
              return (
                <li key={r.reviewId}>
                  <article className="card col h-full gap-2 p-4 lg:p-[18px]">
                    <div className="row wrap" style={{ gap: '4px 8px' }}>
                      <strong className="t-sm fw-b">{r.authorDisplay ?? '익명'}</strong>
                      {attended !== undefined ? <span className="t-xs muted">{attendedText(attended)}</span> : null}
                      {written !== undefined ? <span className="t-xs muted num">{writtenText(written)}</span> : null}
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      <Stars n={rating} />
                      <span className="t-xs fw-b">5점 만점에 {rating}점</span>
                    </div>
                    <p className="t-sm grow line-clamp-3">{r.body}</p>
                    {photos.length > 0 ? (
                      <ul className="row" style={{ gap: 8 }} aria-label={`${r.authorDisplay ?? '익명'}의 후기 사진 ${photos.length}장`}>
                        {photos.map((ph, k) => (
                          <li key={ph.imageId ?? k}>
                            <Link
                              className="center h-[72px] w-[72px] overflow-hidden rounded-(--r-md)"
                              href={`${path}?reviews=all&review=${encodeURIComponent(r.reviewId!)}&photo=${k + 1}`}
                              scroll={false}
                              aria-haspopup="dialog"
                              aria-label={`${r.authorDisplay ?? '익명'}의 후기 사진 ${k + 1}/${photos.length} 크게 보기`}
                              style={{ background: 'var(--fill-weak)', color: 'var(--text-muted)' }}
                            >
                              {ph.thumbnailUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element -- 후기 사진 목록 파생본을 CDN에서 바로 받는다
                                <img src={ph.thumbnailUrl} alt="" width={72} height={72} loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                              ) : (
                                <i className="ic ic-image ic-24" aria-hidden="true" />
                              )}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <Link
                      className="btn btn-ghost btn-sm self-start"
                      href={`${path}?report=${encodeURIComponent(r.reviewId!)}`}
                      scroll={false}
                      aria-haspopup="dialog"
                      aria-label={`${r.authorDisplay ?? '익명'}의 후기 신고`}
                      style={{ marginLeft: -12 }}
                    >
                      <i className="ic ic-flag" aria-hidden="true" />
                      신고
                    </Link>
                  </article>
                </li>
              );
            })}
          </ul>
        ) : null}
        <Link
          className="btn btn-secondary btn-lg btn-block lg:inline-flex lg:w-auto lg:min-w-[360px] lg:self-center"
          href={`${path}?reviews=all`}
          scroll={false}
          aria-haspopup="dialog"
        >
          후기 {count.toLocaleString('ko-KR')}개 전체보기
        </Link>
      </>
    );
  }
  return (
    <section className={cx(sectionClass, 'gap-4')} id="sec-review" aria-labelledby="h-review">
      <div className="section-title">
        <h2 id="h-review">후기</h2>
        {write}
      </div>
      {body}
    </section>
  );
}

/** SCR-016 후기 모달(주소 값으로 띄움). 로그인 여부는 개인 값 요청의 401로 안다 */
export function DetailReviewModals({ eventId, title, rounds }: { eventId: string; title: string; rounds: readonly { value: string; label: string }[] }) {
  const { status } = useDetailPersonal();
  return <ReviewModalsFromUrl eventId={eventId} title={title} rounds={rounds} guest={status === 'guest'} />;
}
