// 연구 원천의 문구·자리(SCR-069 운영, 연구 메뉴에서 연다). 정본: docs/features/forensic-replay.md §2.1·§6.3·§6.8.
import { BADGE, COPY_OPERATING, EVENT, NOTICE_BOT, type SourceSpec } from '../source-spec.ts';

export const researchSpec: SourceSpec = {
  source: 'research',
  badge: BADGE.research,
  title: '포렌식 리플레이 · 연구 원천',
  notice: NOTICE_BOT,
  headerNote: '가명 기록 · 30분 동안 쓰지 않으면 지워짐',
  event: EVENT,
  window: '시간창 T+00:00 ~ T+30:00',
  consolePath: '/dashboard',
  synthControls: false,
  precisionRecall: false,
  filters: { botGrade: false, network: false, group: false },
  candidate: 'distribution',
  candidateTitle: "후보 · '입장 확정 → 첫 홀드' 분포",
  deviceGroups: false,
  seatMarks: false,
  expired: '이 회차의 가명 기록은 보존 기간(90일)이 지났습니다',
  pickedArea: '분포 구간(10ms~100ms)',
  rejectReason: '받은 파일의 원천이 이 탭을 연 길(연구 메뉴 · 연구 원천)과 다릅니다. 아무것도 그리지 않았습니다',
  rejectHint: '연구 메뉴에서 리플레이를 다시 열어 주세요',
  copyNote: COPY_OPERATING,
};
