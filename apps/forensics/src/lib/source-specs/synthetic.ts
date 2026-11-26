// 합성 데이터 원천의 문구·자리(SCR-069 시험·시연). 운영 빌드는 이 파일을 가져오지 않는다(F-04-16).
import { BADGE, NOTICE_BOT, type SourceSpec } from '../source-spec.ts';

export const syntheticSpec: SourceSpec = {
  source: 'synthetic',
  badge: BADGE.synthetic,
  title: '포렌식 리플레이 · 합성 데이터 데모',
  notice: NOTICE_BOT,
  synthControls: true,
  precisionRecall: true,
  filters: { botGrade: true, network: true, group: false },
  candidate: 'scatter',
  candidateTitle: '봇 후보',
  deviceGroups: true,
  seatMarks: false,
  pickedArea: '산점도 영역(100ms 안, 엔트로피 0.24 아래)',
  rejectReason: '앞뒤 매직 ARROW1이 없습니다. 아무것도 그리지 않았습니다',
  rejectHint: '프리셋을 고르거나 다른 파일을 불러오세요',
  copyNote: '이 공개 위치는 교차 출처 격리를 켜지 않아 복사 방식으로 동작합니다. 결과는 같고 반응이 조금 늦을 수 있습니다',
};
