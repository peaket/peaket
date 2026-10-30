// 회차와 온세일 단계(목업). 공연·공연장 이름은 d5에 나온 지어낸 이름이다.
export type RunStage = 'T-30분 점검' | 'T=0' | '판매 중' | '종료 후' | '입장(공연 당일)';

export interface EventRun {
  id: string;
  /** 위 상태 바 회차 칩(데스크톱) */
  label: string;
  /** 휴대폰 칩 */
  short: string;
  title: string;
  venue: string;
  seats: number;
  scale: '대형' | '중형' | '소형';
  openAt: string;
  pg: { primary: string; fallback: string };
}

export const CURRENT_RUN: EventRun = {
  id: 'evt-lumen-2026-r1',
  label: 'LUMEN 10/25 18:00 · 대형',
  short: 'LUMEN 10/25 · 대형',
  title: 'LUMEN 콘서트 2026 서울 · 1회차 10/25(일) 18:00 KST',
  venue: '피켓 아레나',
  seats: 2400,
  scale: '대형',
  openAt: '10/14(수) 20:00 KST',
  pg: { primary: '토스페이먼츠', fallback: '포트원' },
};

/** 회차 고르기 목록(동시 진행 회차 개요: 대형 1 + 중형 2) */
export const RUNS: readonly EventRun[] = [
  CURRENT_RUN,
  { ...CURRENT_RUN, id: 'evt-aurora-r2', label: 'AURORA 10/18 19:30 · 중형', short: 'AURORA 10/18 · 중형', title: 'AURORA 팬미팅 · 2회차', seats: 900, scale: '중형' },
  { ...CURRENT_RUN, id: 'evt-mono-r1', label: '모노 뮤지컬 10/16 20:00 · 중형', short: '모노 10/16 · 중형', title: '뮤지컬 모노 · 1회차', seats: 1200, scale: '중형' },
];

export const STAGES: readonly RunStage[] = ['T-30분 점검', 'T=0', '판매 중', '종료 후', '입장(공연 당일)'];
