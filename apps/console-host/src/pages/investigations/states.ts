// SCR-070 부정 거래 조사 사건 목록의 상태(d5 §7.18 상태 표). 디자인 캔버스 보드가 없어 d5의 이름을 쓴다(add-fraud-investigation-screens).
export const STATES = [
  '후보 묶음',
  '사건 만들기',
  '게시물 파일 거절',
  '취소 마감 12시간 전',
  '취소 마감 2시간 전',
  '취소 마감 지남',
  '늦은 적재',
  '후보 아직 없음',
  '후보 만들기 실패',
  '원천 만료',
  '불러오는 중',
  '권한 없음(지정 없음)',
] as const;
export type State = (typeof STATES)[number];
export const DEFAULT: State = '후보 묶음';
