// 후기 목업(SCR-016 후기 전체 모달·사진 보기·신고 대상, 보드 SCR-016-m·t·d의 목록 그대로). 합성 데이터다.
// 작성자는 닉네임 첫 글자 + '**'(d5 §5.16), 관람 회차와 작성일만 보인다. 이메일·전화번호·실명은 두지 않는다.
// 평균·개수와 '1234'·'1233'은 공연 상세 미리보기(_pages/event-detail/model/content.ts)와 같다. 같은 공연의 모든 회차 후기다(ADR-0093).

export interface ReviewPhoto {
  /** 사진 설명(대체 텍스트). 비면 '후기 사진 n/전체'로 읽는다 */
  caption: string;
}

export type ReviewItem =
  | {
      kind: 'review';
      /** 게시물 번호 */
      id: string;
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
      /** 내 글이 통보로 차단한 글과 같아 자동으로 숨겨짐(<노출 제한>) */
      restricted?: boolean;
    }
  | {
      kind: 'notice';
      id: string;
      order: number;
      /** 조치된 후기 자리의 공시 */
      text: string;
      label: string;
    };

export type Review = Extract<ReviewItem, { kind: 'review' }>;

export const REVIEW_SUMMARY = { average: 4.6, count: 128 } as const;

export const REVIEW_ITEMS: readonly ReviewItem[] = [
  {
    kind: 'review',
    id: '1241',
    author: '박**',
    watched: '10월 26일 17:00 관람',
    written: '10/26 작성',
    order: 7,
    stars: 3,
    body: '공연은 좋았지만 퇴장 동선이 붐볐습니다. 다음에는 안내가 더 있으면 좋겠습니다.',
    photos: [],
  },
  {
    kind: 'review',
    id: '1238',
    author: '지**',
    watched: '10월 26일 17:00 관람',
    written: '10/26 작성',
    order: 6,
    stars: 5,
    body: '기다린 보람이 있었습니다. 앙코르 무대까지 모두 좋았습니다.',
    photos: [],
    mine: true,
  },
  {
    kind: 'review',
    id: '1234',
    author: '김**',
    watched: '10월 25일 18:00 관람',
    written: '10/25 작성',
    order: 5,
    stars: 4,
    body: '무대 연출과 음향이 좋았습니다. 입장 줄이 길었지만 안내가 잘 되어 있어 금방 들어갔습니다. 다음 공연도 보러 오겠습니다.',
    photos: [{ caption: '[예시] 공연 시작 전 무대 모습' }, { caption: '' }, { caption: '[예시] 공연이 끝난 뒤 객석 모습' }],
  },
  {
    kind: 'review',
    id: '1233',
    author: '이**',
    watched: '10월 25일 18:00 관람',
    written: '10/25 작성',
    order: 4,
    stars: 5,
    body: '처음 가 본 공연장인데 좌석에서 무대가 잘 보였습니다. 공연도 안내된 시각에 끝나서 돌아가기 편했습니다.',
    photos: [{ caption: '[예시] 2층 좌석에서 본 무대' }],
  },
  { kind: 'notice', id: 'n-1232', order: 3, text: '권리 침해 신고로 임시조치된 후기입니다(11/18까지)', label: '임시조치된 후기' },
  { kind: 'notice', id: 'n-1231', order: 2, text: '운영정책에 따라 가려진 후기입니다', label: '가려진 후기' },
  {
    kind: 'review',
    id: '1230',
    author: '지**',
    watched: '10월 25일 18:00 관람',
    written: '10/25 작성',
    order: 1,
    stars: 4,
    body: '',
    photos: [],
    mine: true,
    restricted: true,
  },
];

export function getReview(id: string): Review | undefined {
  const item = REVIEW_ITEMS.find((r) => r.kind === 'review' && r.id === id);
  return item?.kind === 'review' ? item : undefined;
}

export type ReviewSort = 'latest' | 'high' | 'low';

export const REVIEW_SORT_LABEL: Record<ReviewSort, string> = { latest: '최신 순', high: '별점 높은 순', low: '별점 낮은 순' };

/** 정렬: 최신 순은 작성 순서, 별점 순은 후기만 별점으로(같으면 최신), 조치된 자리의 공시는 맨 뒤 */
export function sortReviewItems(items: readonly ReviewItem[], sort: ReviewSort): ReviewItem[] {
  if (sort === 'latest') return [...items].sort((a, b) => b.order - a.order);
  const reviews = items.filter((r): r is Review => r.kind === 'review' && !r.restricted);
  const rest = items.filter((r) => r.kind !== 'review' || r.restricted);
  reviews.sort((a, b) => (sort === 'high' ? b.stars - a.stars : a.stars - b.stars) || b.order - a.order);
  return [...reviews, ...rest.sort((a, b) => b.order - a.order)];
}

/** 계정 이메일(가린 값). 신고 '처리 결과를 받을 곳'에 보인다 */
export const MY_MASKED_EMAIL = 'ji****@k*****.com';

/** 후기 쓰기 금칙어(정규화 뒤 일치, 목업 예시). 실제 목록은 서버가 가진다 */
export const BANNED_PHRASES: readonly string[] = ['매크로 대행', '대리 예매', '자동 예매 프로그램 판매'];
