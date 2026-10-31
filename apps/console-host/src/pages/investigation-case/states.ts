// SCR-071 사건 작업대의 상태(d5 §7.19 상태 표). 디자인 캔버스 보드가 없어 d5의 이름을 쓴다(add-fraud-investigation-screens).
// 사건마다의 기본 상태는 그 사건의 상태다(조사 중 · 소명 대기 · 결정 대기 · 조치됨 · 이의 접수 · 정상 종료).
export const STATES = [
  '조사 중',
  '점 고름(IP)',
  'IP 원문 열기',
  'IP 원문 열림',
  '계정 빼기',
  '새로 이어진 계정',
  '소명 요청 확인',
  '소명 대기',
  '결정 대기',
  '조치됨',
  '이의 접수',
  '정상 종료',
  '취소 마감 지남',
  '그래프가 너무 큼',
  '증거 없음',
  '불러오는 중',
  '권한 없음(지정 없음)',
] as const;
export type State = (typeof STATES)[number];
export const DEFAULT: State = '조사 중';
