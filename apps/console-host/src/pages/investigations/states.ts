// SCR-070 부정 거래 조사 사건 목록의 상태(d5 §7.18 상태 표). 디자인 캔버스 보드가 없어 d5의 이름을 쓴다(add-fraud-investigation-screens).
// '후보 만들기 다시 시도 중'(FRN-070)과 외부 게시물 등록 422(신고 출처가 외부 되팔이 게시물 신고 건이 아님, d5 §9.2, ADR-0173 결정 9)는
// apply-legal-review-to-screens에서 더했다. 오류 응답으로만 보이는 화면은 '오류 · …' 꼴이다(그 design.md 결정 3, 이 422에는 type 이름이 없다).
export const STATES = [
  '후보 묶음',
  '사건 만들기',
  '게시물 파일 거절',
  '오류 · 신고 출처 아님',
  '취소 마감 12시간 전',
  '취소 마감 2시간 전',
  '취소 마감 지남',
  '늦은 적재',
  '후보 아직 없음',
  '후보 만들기 다시 시도 중',
  '후보 만들기 실패',
  '원천 만료',
  '불러오는 중',
  '권한 없음(지정 없음)',
] as const;
export type State = (typeof STATES)[number];
export const DEFAULT: State = '후보 묶음';
