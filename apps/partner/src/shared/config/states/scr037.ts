// SCR-037 현장 스태프·현장 운영 상태(보드 SCR-037-m·t·d의 state 열거값, 기본 '스태프').
// '현장 운영'부터 '이상 표시 없음'까지 여섯은 [현장 운영] 하위 탭이고, 나머지는 [스태프] 하위 탭이다.
// d5 §6.11의 '동기화 지연 경보'는 보드처럼 '현장 운영'(입장 중) 안에 그린다.
export const STAFF_STATES = [
  '스태프',
  '현장 운영',
  '입장 전 준비',
  '배치 바꾸기',
  '퇴장 모드 불가',
  '입장 기록 마감 뒤',
  '이상 표시 없음',
  '빈 화면',
  '초대 실패',
  '권한 해제 확인',
] as const;

export type StaffState = (typeof STAFF_STATES)[number];

export const STAFF_OPS_STATES: readonly StaffState[] = ['현장 운영', '입장 전 준비', '배치 바꾸기', '퇴장 모드 불가', '입장 기록 마감 뒤', '이상 표시 없음'];
