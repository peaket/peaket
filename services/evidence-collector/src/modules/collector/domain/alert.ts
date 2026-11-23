// 경보 고르기(docs/observability.md §5 '진단 증거' 수집하는 경보, ADR-0070 결정 1, 시험 D-T51 ③).
// 발생(firing) 중인 경보 가운데 severity sev1, severity sev2이면서 kind cause, 경보 이름 IncidentDeclared만 뜬다. 해제 경보와 그 밖의 경보는 세기만 한다.
// dependency 라벨이 있으면 같은 이름의 수집 대상 하나를, 없으면 모든 수집 대상을 뜬다. 그 이름의 대상이 없으면 뜨지 않는다(unknown_dependency).

/** Alertmanager 기본 웹훅(판 4)의 경보 하나에서 고르기에 쓰는 칸 */
export interface WebhookAlert {
  status: string;
  labels: Readonly<Record<string, string>>;
  fingerprint?: string;
}

export type AlertDecision = 'collect' | 'ignored' | 'unknown_dependency';
export const ALERT_DECISIONS: readonly AlertDecision[] = ['collect', 'ignored', 'unknown_dependency'];

/** 인시던트 선언 경보 이름(관제 콘솔이 선언 때 이 이름으로 보낸다) */
export const INCIDENT_DECLARED = 'IncidentDeclared';

/** 경보 하나를 뜰지 정하고, 뜬다면 그 대상 이름 목록을 낸다 */
export function decideAlert(alert: WebhookAlert, targetNames: readonly string[]): { decision: AlertDecision; targets: string[] } {
  if (alert.status !== 'firing') return { decision: 'ignored', targets: [] };
  const { alertname, severity, kind, dependency } = alert.labels;
  const wanted = alertname === INCIDENT_DECLARED || severity === 'sev1' || (severity === 'sev2' && kind === 'cause');
  if (!wanted) return { decision: 'ignored', targets: [] };
  if (dependency === undefined || dependency === '') return { decision: 'collect', targets: [...targetNames] };
  if (!targetNames.includes(dependency)) return { decision: 'unknown_dependency', targets: [] };
  return { decision: 'collect', targets: [dependency] };
}

/** manifest.json에 싣는 경보 칸(지문·이름·severity·kind·dependency). 경보 설명 글(annotations)은 싣지 않는다 */
export interface ManifestAlert {
  fingerprint?: string;
  alertname?: string;
  severity?: string;
  kind?: string;
  dependency?: string;
}

export function manifestAlert(alert: WebhookAlert): ManifestAlert {
  const { alertname, severity, kind, dependency } = alert.labels;
  return { fingerprint: alert.fingerprint, alertname, severity, kind, dependency };
}
