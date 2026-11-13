// 후기 화면 모델(SCR-016, ADR-0063·0066). API 응답(@peaket/api-client)을 화면 카드로 바꾸는 순수 함수만 둔다.
// 작성자는 닉네임 첫 글자 + '**'(d5 §5.16), 관람 회차와 작성일만 보인다. 이메일·전화번호·실명은 두지 않는다.
// 목업 REVIEW_ITEMS는 걷어 냈다. 실제 값은 core-svc GET /v1/events/{eventId}/reviews가 준다.
import type { Review as ApiReview, ReviewPage as ApiReviewPage, ReviewSummary as ApiReviewSummary } from '@peaket/api-client/model';

const KST_MS = 9 * 60 * 60_000;
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

/** KST 시각의 날짜·요일·시분(공용 shared/lib/kst와 같은 규칙. node 시험이 이 파일만 읽게 작게 둔다) */
function kstParts(ms: number): { m: number; d: number; wd: string; hh: string; mm: string } {
  const k = new Date(ms + KST_MS);
  return { m: k.getUTCMonth() + 1, d: k.getUTCDate(), wd: WEEKDAY[k.getUTCDay()]!, hh: String(k.getUTCHours()).padStart(2, '0'), mm: String(k.getUTCMinutes()).padStart(2, '0') };
}

function parseTime(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

export interface ReviewPhoto {
  /** 사진 설명(대체 텍스트). 비면 '후기 사진 n/전체'로 읽는다 */
  caption: string;
  /** 큰 사진 주소(서버 파생본) */
  url?: string;
  /** 목록 썸네일 주소 */
  thumbnailUrl?: string;
}

export interface Review {
  kind: 'review';
  /** 게시물 번호(reviewId) */
  id: string;
  eventId?: string;
  author: string;
  /** '10월 25일 18:00 관람' */
  watched: string;
  /** '10/25 작성' */
  written: string;
  /** 정렬용 작성 순서(클수록 최근) */
  order: number;
  stars: number;
  body: string;
  photos: readonly ReviewPhoto[];
  /** 내 후기(신고 대신 수정·삭제) */
  mine?: boolean;
  /** 이미 신고한 후기([신고함]) */
  reportedByMe?: boolean;
  /** 내 글이 통보로 차단한 글과 같아 자동으로 숨겨짐(<노출 제한>) */
  restricted?: boolean;
  status?: 'VISIBLE' | 'HIDDEN';
  notice?: 'RIGHTS_TEMP' | 'POLICY';
  noticeUntil?: string;
  permalink?: string;
}

export interface ReviewNoticeItem {
  kind: 'notice';
  id: string;
  order: number;
  /** 조치된 후기 자리의 공시 */
  text: string;
  label: string;
}

export type ReviewItem = Review | ReviewNoticeItem;

export type ReviewSort = 'latest' | 'high' | 'low';

export const REVIEW_SORT_LABEL: Record<ReviewSort, string> = { latest: '최신 순', high: '별점 높은 순', low: '별점 낮은 순' };

/** 화면 정렬 → API 쿼리(docs/api/openapi.yaml GET /v1/events/{eventId}/reviews) */
export function reviewSortParam(sort: ReviewSort): 'LATEST' | 'RATING_DESC' | 'RATING_ASC' {
  return sort === 'high' ? 'RATING_DESC' : sort === 'low' ? 'RATING_ASC' : 'LATEST';
}

function watchedText(iso: string | undefined): string {
  const t = parseTime(iso);
  if (t === undefined) return '';
  const k = kstParts(t);
  return `${k.m}월 ${k.d}일 ${k.hh}:${k.mm} 관람`;
}

function writtenText(iso: string | undefined): string {
  const t = parseTime(iso);
  if (t === undefined) return '';
  const k = kstParts(t);
  return `${k.m}/${k.d} 작성`;
}

function noticeText(view: ApiReview): string {
  if (view.notice === 'RIGHTS_TEMP') {
    const until = parseTime(view.noticeUntil);
    if (until === undefined) return '권리 침해 신고로 임시조치된 후기입니다';
    const k = kstParts(until);
    return `권리 침해 신고로 임시조치된 후기입니다(${k.m}/${k.d}까지)`;
  }
  return '운영정책에 따라 가려진 후기입니다';
}

/** API 후기 하나를 화면 카드로. reviewId가 없으면 그리지 않는다 */
export function mapReview(view: ApiReview): ReviewItem | undefined {
  if (!view.reviewId) return undefined;
  const order = parseTime(view.createdAt) ?? 0;
  if (view.notice) {
    return { kind: 'notice', id: view.reviewId, order, text: noticeText(view), label: view.notice === 'RIGHTS_TEMP' ? '임시조치된 후기' : '가려진 후기' };
  }
  const restricted = view.status === 'HIDDEN';
  return {
    kind: 'review',
    id: view.reviewId,
    ...(view.eventId ? { eventId: view.eventId } : {}),
    author: view.authorDisplay ?? '***',
    watched: watchedText(view.attendedStartsAt),
    written: writtenText(view.createdAt),
    order,
    stars: restricted ? 0 : (view.rating ?? 0),
    body: restricted ? '' : (view.body ?? ''),
    photos: restricted ? [] : (view.images ?? []).map((img) => ({ caption: img.alt ?? '', ...(img.url ? { url: img.url } : {}), ...(img.thumbnailUrl ? { thumbnailUrl: img.thumbnailUrl } : {}) })),
    ...(view.mine ? { mine: true } : {}),
    ...(view.reportedByMe ? { reportedByMe: true } : {}),
    ...(restricted ? { restricted: true } : {}),
    ...(view.status ? { status: view.status } : {}),
    ...(view.permalink ? { permalink: view.permalink } : {}),
  };
}

/** API 목록 한 쪽을 화면 카드로. 서버가 준 순서를 그대로 둔다 */
export function mapReviewPage(page: ApiReviewPage): { items: ReviewItem[]; nextCursor: string | null } {
  return {
    items: (page.items ?? []).flatMap((r) => {
      const item = mapReview(r);
      return item ? [item] : [];
    }),
    nextCursor: page.nextCursor ?? null,
  };
}

/** 요약(평균 별점·후기 수). 후기가 없으면 averageRating은 null */
export function mapReviewSummary(s: ApiReviewSummary): { average: number | null; count: number } {
  return { average: s.averageRating ?? null, count: s.count ?? 0 };
}

/** 정렬: 최신 순은 작성 순서, 별점 순은 후기만 별점으로(같으면 최신), 조치된 자리의 공시는 맨 뒤 */
export function sortReviewItems(items: readonly ReviewItem[], sort: ReviewSort): ReviewItem[] {
  if (sort === 'latest') return [...items].sort((a, b) => b.order - a.order);
  const reviews = items.filter((r): r is Review => r.kind === 'review' && !r.restricted);
  const rest = items.filter((r) => r.kind !== 'review' || r.restricted);
  reviews.sort((a, b) => (sort === 'high' ? b.stars - a.stars : a.stars - b.stars) || b.order - a.order);
  return [...reviews, ...rest.sort((a, b) => b.order - a.order)];
}

/** 신고 대상 상자(작성자·관람 회차·게시물 번호·본문 첫 줄) */
export function reviewTargetOf(item: Review): { author: string; watched: string; postId: string; excerpt: string } {
  return { author: item.author, watched: item.watched, postId: item.id, excerpt: item.body };
}

/** 계정 이메일(가린 값). 신고 '처리 결과를 받을 곳'에 보인다. 계정 API가 생기면 그 값으로 바꾼다 */
export const MY_MASKED_EMAIL = 'ji****@k*****.com';

/** 후기 쓰기 금칙어(정규화 뒤 일치, 화면의 즉시 안내용). 정본은 서버가 가진다 */
export const BANNED_PHRASES: readonly string[] = ['매크로 대행', '대리 예매', '자동 예매 프로그램 판매'];
