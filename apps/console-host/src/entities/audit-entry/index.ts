// 감사 기록(목업). 시각은 UTC이고 팬 관련 대상은 가명 참조값만 둔다(d5 §7.4).
// 감사 화면(SCR-031)은 보드의 표를 그대로 옮겼고, 이 목업은 다른 화면(대시보드 '감사 타임라인' 등)이 줄 몇 개를 보일 때 쓴다.
export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  target: string;
  approver?: string;
  result: string;
}

export const AUDIT_SAMPLE: readonly AuditEntry[] = [
  { at: '11:01:40', actor: '시스템 · 경보', action: 'SEV1 결제 확정 지연', target: 'purchase-svc', result: '알림' },
  { at: '11:03:53', actor: '민호 · operator', action: '명령 3 판매 일시정지', target: 'LUMEN 10/25 18:00', result: 'ack 3/3' },
  { at: '11:10:30', actor: '시스템 · 자동 조치', action: '결제 신규 진입 재개', target: '토스페이먼츠', result: '풀림' },
];
