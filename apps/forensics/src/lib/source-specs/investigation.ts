// 조사 원천의 문구·자리(SCR-069 운영, 사건 작업대에서 연다). 정본: docs/features/forensic-replay.md §2.1·§6.8.
import { BADGE, COPY_OPERATING, EVENT, NOTICE_INVESTIGATION, type SourceSpec } from '../source-spec.ts';

export const investigationSpec: SourceSpec = {
  source: 'investigation',
  badge: BADGE.investigation,
  title: '포렌식 리플레이 · 조사 원천',
  notice: NOTICE_INVESTIGATION,
  headerNote: '조사용 기록 · 이 탭에만 있고 내려받지 않습니다',
  event: EVENT,
  caseLabel: '사건 CASE-2610-0007',
  window: '시간창 T−10:00 ~ T+20:00',
  consolePath: '/investigations/CASE-2610-0007',
  synthControls: false,
  precisionRecall: false,
  filters: { botGrade: false, network: false, group: true },
  candidate: 'baseline',
  candidateTitle: '후보 · 단계별 시간 대 정상 기준선',
  deviceGroups: true,
  seatMarks: true,
  expired: '이 회차의 조사용 기록은 보존 기간이 지났습니다. 증거 묶음만 볼 수 있습니다',
  pickedArea: '기준선 칸(묶음 계정 #3 · 입장 확정 → 첫 홀드)',
  rejectReason: '받은 파일의 원천이 이 탭을 연 길(사건 작업대 · 조사 원천)과 다릅니다. 아무것도 그리지 않았습니다',
  rejectHint: '사건 작업대에서 리플레이를 다시 열어 주세요',
  copyNote: COPY_OPERATING,
};
