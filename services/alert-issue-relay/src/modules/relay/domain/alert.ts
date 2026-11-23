// 경보 티켓의 알맹이(도메인). 정본: docs/observability.md §5 '경보 보내는 길' 티켓 중계·'문구에 싣는 것',
// ADR-0139 결정 4(온콜·협업 도구에 이용자 식별값 금지), V-T53 ④⑤.
// Slack 문구와 같은 원칙으로 정한 라벨·주석만 싣고, 싣는 글은 부르는 쪽이 넘긴 2차 마스킹 함수로 한 번 더 가린다
// (도메인은 프레임워크·바깥 패키지를 모른다, docs/architecture.md §3.1).

/** GitHub에서 경보 티켓을 고르는 라벨 */
export const ALERT_LABEL = 'peaket-alert';
/** 티켓 본문에서 지문을 찾는 줄 앞머리(한 줄 전체가 이 꼴이어야 한다) */
export const FINGERPRINT_PREFIX = 'peaket-alert-fingerprint: ';

const LABELS = ['severity', 'kind', 'event_id', 'journey', 'dependency'] as const;
const ANNOTATIONS = ['runbook_url', 'dashboard_url', 'explore_url'] as const;

export interface AlertInput {
  status: 'firing' | 'resolved';
  labels: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt: string;
  endsAt: string;
  fingerprint: string;
}

export interface IssueRef {
  number: number;
}

export const isTicketAlert = (a: AlertInput): boolean => a.labels.severity === 'sev3';

export const issueTitle = (a: AlertInput, mask: (text: string) => string): string => `[SEV3] ${mask(a.labels.alertname ?? 'alert')}`;

export function issueBody(a: AlertInput, mask: (text: string) => string): string {
  const lines: string[] = [];
  const summary = mask(a.annotations?.summary ?? '');
  if (summary !== '') lines.push(summary, '');
  lines.push(`${FINGERPRINT_PREFIX}${a.fingerprint}`);
  for (const k of LABELS) if (a.labels[k]) lines.push(`${k}: ${mask(a.labels[k]!)}`);
  for (const k of ANNOTATIONS) if (a.annotations?.[k]) lines.push(`${k}: ${mask(a.annotations[k]!)}`);
  return `${lines.join('\n')}\n`;
}

export function resolvedComment(a: AlertInput, mask: (text: string) => string): string {
  const summary = mask(a.annotations?.summary ?? '');
  return summary === '' ? '해제' : `해제: ${summary}`;
}

/** 본문에 그 지문 줄이 정확히 있는가(앞뒤 공백만 허용, 더 긴 지문은 다른 지문이다) */
export const hasFingerprint = (body: string | undefined, fingerprint: string): boolean =>
  (body ?? '').split(/\r?\n/).some((line) => line.trim() === `${FINGERPRINT_PREFIX}${fingerprint}`);
