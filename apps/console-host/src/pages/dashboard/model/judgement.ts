// 위젯 아래 '판단:' 한 줄의 글(F-03-3 OPS-380, docs/design/d5-screen-blueprint.md §7.2 '위젯의 연결 판단' 표, ADR-0069).
// 글은 이 한 곳에 두고 호스트 위젯(ui/live)과 원격 위젯 자리(RemoteWidget)가 함께 쓴다. 운영 명령이 없는 진단 힌트에는 판단 줄이 없다.
const JUDGEMENTS: Record<string, string> = {
  'ops-readiness.checklist': '필수 항목이 하나라도 실패하면 No-Go다. T-20분까지 회복되면 다시 판정하고, 프리워밍이 모자라면 RB-02',
  'ops-budget.journeys': '판단 순서 ②. 최근 변경이면 되돌리기(RB-23) → 명령 1 → 2 → 6 → 3',
  'ops-saturation.summary': "'위험'이면 명령 1로 목표를 낮추고 엔지니어를 부른다",
  'purchase-pg-status.summary': '임박 원인(SEV2)이면 결제사 상태를 보고 필요하면 명령 1로 목표를 낮춘다. 결제 확정 소요 p99 5초 초과나 서킷 열림이면 RB-07: 명령 6(결제사 전환, 2인). 한도에 가까우면 명령 1',
  'queue-admission-rate.summary': '명령은 없다. 빈자리가 줄면 serving 전진이 자동으로 느려진다',
  'ops-control.status': '기대치와 다르면 자동 제어 상태를 보고 명령 1·2',
};

/** 위젯 키의 판단 글. 판단 줄을 두지 않는 위젯(진단 힌트 등)은 undefined */
export function judgementOf(widgetKey: string): string | undefined {
  return JUDGEMENTS[widgetKey];
}
