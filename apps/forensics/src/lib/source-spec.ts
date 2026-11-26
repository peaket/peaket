// 포렌식 리플레이 원천별 문구·자리의 타입과 공용 상수. 시험·시연(source.ts)은 셋을 모두 쓰고,
// 운영(operating.ts)은 조사·연구만 가져와 합성 spec이 운영 묶음에 들어가지 않게 한다(F-04-16, RV0416-04).
import type { ReplaySource, replaySourceLabel } from '@peaket/ds/ReplaySourceBadge';

export type Source = ReplaySource;
export type CandidateKind = 'scatter' | 'baseline' | 'distribution';

export interface SourceSpec {
  source: Source;
  /** 원천 배지 글자(CMP-082) */
  badge: string;
  /** 화면 제목(h1, 화면 낭독기용). 원천을 넣는다(CMP-082 접근성) */
  title: string;
  /** 후보 패널에 늘 두는 고정 문구(forensic-replay §2.1) */
  notice: string;
  /** 머리 안내 글(조사·연구) */
  headerNote?: string;
  /** 머리의 회차(조사·연구) */
  event?: string;
  /** 머리의 사건(조사) */
  caseLabel?: string;
  /** 머리의 시간창(조사·연구) */
  window?: string;
  /** 머리 끝 ( 관제 콘솔 › )이 가는 관제 경로(조사·연구) */
  consolePath?: string;
  /** 시나리오 ▾·시드·[다시 만들기]·[파일 불러오기]·[이 시나리오 내려받기]·공유 주소 복사(합성만, §6.8) */
  synthControls: boolean;
  /** 정밀도·재현율과 그 경고(정답이 있는 합성만) */
  precisionRecall: boolean;
  /** 교차 필터: 봇 등급(합성 정답)·네트워크 유형(합성만), 묶음(조사만) */
  filters: { botGrade: boolean; network: boolean; group: boolean };
  /** 후보 패널: 산점도(CMP-079) · 단계별 시간 대 정상 기준선(CMP-083) · 한 축 분포(CMP-079 한 축) */
  candidate: CandidateKind;
  /** 후보 패널 제목 */
  candidateTitle: string;
  /** 기기 묶음 목록(연구에는 기기 묶음이 없다, §6.3) */
  deviceGroups: boolean;
  /** 묶음 계정 좌석·게시물 대조 좌석 점등(조사, §4.2 member·post_seat) */
  seatMarks: boolean;
  /** 원천 만료 문구(조사·연구) */
  expired?: string;
  /** '후보 고름'에서 교차 필터에 적는 고른 영역 */
  pickedArea: string;
  /** 파일 거절 띠의 이유 한 줄 */
  rejectReason: string;
  /** 파일 거절 때 좌석맵 자리 안내 */
  rejectHint: string;
  /** 복사 방식 띠 */
  copyNote: string;
}

/** 원천 배지 글자. ds 부품(CMP-082)의 글자와 다르면 타입 검사가 막는다 */
export const BADGE = { investigation: '조사', research: '연구', synthetic: '합성 데이터' } as const satisfies typeof replaySourceLabel;

export const NOTICE_BOT = '후보 찾기용입니다. 봇 판정은 표본 검토(SCR-067)와 정해진 규칙(POL-006)으로 합니다.';
export const NOTICE_INVESTIGATION = '후보 찾기용입니다. 조치는 사건 작업대에서 소명과 승인을 거쳐 합니다(POL-046).';

/** 조사·연구 원천의 목업 회차(관제 목업 LUMEN 1회차와 같다) */
export const EVENT = 'LUMEN 콘서트 2026 서울 · 10/25(일) 18:00';
export const COPY_OPERATING = '이 탭은 교차 출처 격리를 켜지 않아 복사 방식으로 동작합니다. 결과는 같고 반응이 조금 늦을 수 있습니다';

/** 목업 회차 이름(관제 목업과 같다). 모르는 회차는 ID를 그대로 적는다 */
export const EVENT_LABEL: Record<string, string> = { 'evt-lumen-2026-r1': EVENT };
