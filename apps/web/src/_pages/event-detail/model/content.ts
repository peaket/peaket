// SCR-002 공연 상세의 글 목업과 정본 문구. 법정 고지는 POL 원문 그대로(docs/planning/03 POL-024 라목·POL-037).
// 정렬 방식 문구는 POL-004 표준 문구(d5 §5.2 ②). 후기·설명 글은 지어낸 예시다.
import type { SortMode } from '@/entities/production';

/** POL-024 라목: 부정구매·부정판매 처벌 법정 고지(공연 상세 판매 조건 ⑤). 한 글자도 바꾸지 않는다 */
export const LEGAL_RESALE_NOTICE =
  '매크로 등으로 판매자가 정한 공정한 구입 과정을 우회하거나 방해하여 되팔 목적으로 입장권을 구매하는 부정구매와, 판매자의 동의 없이 상습 또는 영업으로 자신이 구입한 가격보다 비싸게 입장권을 판매하거나 알선하는 부정판매는 1년 이하의 징역 또는 1천만원 이하의 벌금에 처해질 수 있습니다(공연법 §41). 부정판매에는 판매금액의 50배 이하의 과징금이 부과될 수 있습니다(공연법 §4의4).';

/** POL-037 공연용 중개자 고지(판매자 줄 ⑩). 판매자 상호만 바뀐다 */
export function brokerNotice(sellerName: string): string {
  return `판매자: ${sellerName}. PEAKET은 통신판매중개자로서 이 공연의 당사자가 아닙니다. 공연의 개최·변경·취소에 따른 책임은 판매자에게 있고, 예매 취소와 환불은 PEAKET이 처리합니다`;
}

/** 본인확인 목적 문구(③) */
export const VERIFY_PURPOSE = '휴대폰 본인확인은 계정당 한 번만 합니다. 한 사람은 한 계정으로만 예매할 수 있습니다';

/** 정렬 방식 고지(②, POL-004) */
export const SORT_NOTICE: Record<SortMode, { title: string; body: string }> = {
  HYBRID: {
    title: '정렬 방식 · 하이브리드',
    body: '오픈 전에 들어온 분은 오픈 시각에 무작위로 순번을 받습니다. 일찍 들어와도 유리하지 않습니다. 오픈 후에 오신 분은 그 뒤에 도착 순으로 섭니다.',
  },
  PREQUEUE_SHUFFLE: {
    title: '정렬 방식 · 사전 셔플',
    body: '오픈 전에 들어온 분은 오픈 시각에 무작위로 순번을 받습니다. 일찍 들어와도 유리하지 않습니다. 오픈 후에 오신 분은 대기실 참가자 모두의 뒤에 도착 순으로 섭니다.',
  },
  FIFO: {
    title: '정렬 방식 · 선착순',
    body: '오픈 직후 2초 안에 도착한 분들은 같은 시각에 온 것으로 보고 무작위로 순서를 정합니다. 그 뒤에 오신 분은 도착 순으로 섭니다. 순서를 정하는 동안에는 순번이 보이지 않습니다. 오픈 직후 약 20초 안에 순번이 정해지고, 그 뒤 차례대로 입장합니다.',
  },
};

/** 자동 배정 공연 덧붙임(d5 §5.2 ②) */
export const AUTO_SEAT_NOTE = '좌석은 등급 안에서 자동으로 배정됩니다';

/** ⑭ 상세정보(공연 설명 글 + 상세 이미지, 이미지마다 대체 텍스트) */
export const DETAIL_TEXT =
  '2년 만에 서울에서 여는 단독 콘서트입니다. 출연: LUMEN(보컬·기타·베이스·드럼·건반 다섯 명). 관람 유의사항: 공연 중 사진·영상 촬영은 할 수 없고, 공연이 시작된 뒤에는 안내하는 시점에만 들어갈 수 있습니다. 상세 이미지에만 있는 정보(출연진·좌석 시야)는 이 글에도 적었습니다.';

export const DETAIL_IMAGES: readonly { alt: string; height: number; note: string }[] = [
  { alt: '공연 포스터와 출연진 다섯 명 소개', height: 640, note: '세로로 긴 이미지' },
  { alt: '구역별 좌석 시야 안내(R·S·A석)', height: 420, note: '' },
  { alt: '공연장 오시는 길과 입장 게이트(동문·서문)', height: 240, note: '' },
];

/** ⑨ 후기 미리보기(최근 2개, 작성자는 닉네임 첫 글자와 '**') */
export const REVIEW_SUMMARY = { average: 4.6, count: 128 };
export const REVIEWS: readonly { id: string; author: string; watched: string; written: string; stars: number; body: string; photos: number }[] = [
  {
    id: '1234',
    author: '김**',
    watched: '10월 25일 18:00 관람',
    written: '10/25 작성',
    stars: 4,
    body: '무대 연출과 음향이 좋았습니다. 입장 줄이 길었지만 안내가 잘 되어 있어 금방 들어갔습니다. 다음 공연도 보러 오겠습니다.',
    photos: 3,
  },
  {
    id: '1233',
    author: '이**',
    watched: '10월 25일 18:00 관람',
    written: '10/25 작성',
    stars: 5,
    body: '처음 가 본 공연장인데 좌석에서 무대가 잘 보였습니다. 공연도 안내된 시각에 끝나서 돌아가기 편했습니다.',
    photos: 1,
  },
];

/** ⑯ 취소·환불 안내사항: POL-032 공제표 */
export const CANCEL_FEES: readonly [string, string][] = [
  ['예매 후 24시간 안', '없음'],
  ['관람일 10일 전까지', '없음'],
  ['관람일 9~7일 전', '10%'],
  ['관람일 6~3일 전', '20%'],
  ['관람일 2~1일 전', '30%'],
  ['공연 당일 시작 전까지', '90%'],
];
