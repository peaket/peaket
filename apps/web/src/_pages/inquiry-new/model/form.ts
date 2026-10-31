// 문의하기 입력의 처음 값과 검사(d5 §5.30: 유형 필수, 제목 5~50자 [가정], 내용 10~2,000자 [가정]).
// 처음 값은 보드 SCR-056 예시 그대로(상태 '문의 입력 오류'는 보드의 잘못 쓴 예시).
import type { Scr056NewState } from '@/shared/config/screens.discovery';

export interface InquiryDraft {
  type: string;
  orderId: string;
  title: string;
  body: string;
}

export type InquiryErrors = Partial<Record<'type' | 'title' | 'body', string>>;

export const TITLE_MIN = 5;
export const TITLE_MAX = 50;
export const BODY_MIN = 10;
export const BODY_MAX = 2000;

const EXAMPLE_BODY =
  '10/25(일) 18:00 공연을 예매했는데 아이가 아파서 공연에 가기 어려울 것 같습니다. 공연 3일 전에 취소하면 취소 수수료가 생기는데, 이런 사정이면 면제받을 수 있는지 궁금합니다.';

export function initialDraft(state: Scr056NewState): InquiryDraft {
  if (state === '문의 입력 오류') return { type: '', orderId: '', title: '환불', body: '수수료 문의' };
  // 외부 되팔이 게시물 신고(FR-069, ADR-0173 결정 9): 공개 게시물 주소와 설명만. 주소는 문서용 예시 도메인이다(추천 적용 2026-10-31)
  if (state === '외부 되팔이 게시물 신고')
    return {
      type: '외부 되팔이 게시물 신고',
      orderId: '',
      title: '다른 사이트에서 웃돈 판매 글을 봤습니다',
      body: 'https://example.com/market/12345 에 LUMEN 콘서트 2026 서울 10/25(일) R석 2매를 정가의 세 배에 판다는 공개 게시물이 있습니다.',
    };
  return {
    type: '취소·환불(사정이 있어 공제 면제를 요청)',
    orderId: 'ord-20261014-0001',
    title: '아이가 아파서 공연 3일 전 취소 수수료를 면제받을 수 있을까요',
    body: state === '계좌번호 확인 창' ? `${EXAMPLE_BODY} 환불은 [은행] 110-123-456789 계좌로 받고 싶습니다.` : EXAMPLE_BODY,
  };
}

const len = (s: string) => Array.from(s.trim()).length;

export function validateDraft(d: InquiryDraft): InquiryErrors {
  const e: InquiryErrors = {};
  if (!d.type) e.type = '문의 유형을 골라 주세요';
  if (len(d.title) < TITLE_MIN) e.title = '제목을 5자 이상 써 주세요';
  // 상한 넘침 문구는 추천안(d5에 없음)
  else if (len(d.title) > TITLE_MAX) e.title = '제목은 50자까지 쓸 수 있습니다';
  if (len(d.body) < BODY_MIN) e.body = '내용을 10자 이상 써 주세요';
  else if (len(d.body) > BODY_MAX) e.body = '내용은 2,000자까지 쓸 수 있습니다';
  return e;
}
