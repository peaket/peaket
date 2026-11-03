// 부정 거래 조사(SCR-070·071·046)의 계산과 이름표. 서버 계약(openapi 태그 investigations)의 열거값을 화면 글로 옮긴다.
// 이 파일은 실행 때 가져오는 것이 없다(Node 내장 시험 실행기가 타입만 지우고 그대로 읽는다, model.test.mjs). 값 계산은 입력과 출력이 분명해 시험을 먼저 썼다.
// 기준: POL-046 ⑤(취소 마감 = 판매 종료 − 재판매 준비 2시간 = 공연 시작 − 26시간), docs/features/forensic-replay.md §6.7.3·§6.7.5,
// docs/features/control-tower.md §9.2(취소 마감 알림 12·2시간), docs/security/authz-matrix.md §4.3 5(IP는 가린 값).
// 사건 상태·소명 결과·점수 범주의 글과 색은 CMP-081 CaseStatusBadge(@peaket/ds)가 갖는다.

export type FraudCaseStatus = 'INVESTIGATING' | 'APPEAL_PENDING' | 'DECISION_PENDING' | 'ACTIONED' | 'CLEARED' | 'OBJECTED' | 'REVERSED';
export type AppealResult = 'NOT_REQUESTED' | 'PENDING' | 'SUBMITTED' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';
export type ScoreBand = 'HIGH' | 'MEDIUM' | 'LOW';
export type FraudReasonCategory = 'MACRO_BOT' | 'QUEUE_BYPASS' | 'CAPTCHA_BYPASS' | 'ACCOUNT_LENDING' | 'LIMIT_EVASION';
export type FraudSignal = 'LINK_GRAPH' | 'SYNC_STEPS' | 'VELOCITY' | 'TIMING_BASELINE' | 'BYPASS_TRACE' | 'POST_MATCH';
export type FraudLinkKind = 'DEVICE' | 'PAYMENT_METHOD' | 'CONTACT' | 'IP' | 'ASN' | 'IDENTITY_CONFLICT';
export type GraphNodeKind = 'ACCOUNT' | 'DEVICE' | 'PAYMENT_METHOD' | 'CONTACT' | 'IP' | 'ASN';

/** 사유 범주 다섯(POL-046 ①). 팬에게 알리는 것은 이 글뿐이다 */
export const REASON_LABEL: Record<FraudReasonCategory, string> = {
  MACRO_BOT: '자동화 프로그램(매크로·봇)',
  QUEUE_BYPASS: '대기열 우회 링크',
  CAPTCHA_BYPASS: '보안문자 우회',
  ACCOUNT_LENDING: '명의 대여·사들인 계정',
  LIMIT_EVASION: '1인 매수 제한 회피',
};

/** 근거 신호(forensic-replay §6.7.3 R1~R6) */
export const SIGNAL_LABEL: Record<FraudSignal, string> = {
  LINK_GRAPH: '연결 그래프',
  SYNC_STEPS: '동시 행동 군집',
  VELOCITY: '속도 규칙',
  TIMING_BASELINE: '시간 기준선',
  BYPASS_TRACE: '대기열 우회 흔적',
  POST_MATCH: '외부 게시물 대조',
};

/** 공유 속성 종류(openapi FraudLinkKind) */
export const LINK_KIND_LABEL: Record<FraudLinkKind, string> = {
  DEVICE: '기기',
  PAYMENT_METHOD: '결제 수단',
  CONTACT: '연락처',
  IP: 'IP',
  ASN: 'ASN',
  IDENTITY_CONFLICT: '본인확인 충돌',
};

/** 연결 그래프 점 종류의 글(CMP-080 범례). 모양은 화면이 함께 그린다 */
export const NODE_KIND_LABEL: Record<GraphNodeKind, string> = {
  ACCOUNT: '계정',
  DEVICE: '기기',
  PAYMENT_METHOD: '결제 수단',
  CONTACT: '연락처',
  IP: 'IP',
  ASN: 'ASN',
};

export const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const KST = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  month: 'numeric',
  day: 'numeric',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** '10/22(목) 14:20'(KST) */
export function formatKst(iso: string): string {
  const p: Record<string, string> = {};
  for (const part of KST.formatToParts(new Date(iso))) p[part.type] = part.value;
  return `${p.month}/${p.day}(${p.weekday}) ${p.hour}:${p.minute}`;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** 취소 마감 시각 = 공연 시작 − 26시간(판매 종료 24시간 전 − 재판매 준비 2시간 [가정], POL-046 ⑤) */
export function cancelDeadlineAt(showStartIso: string): string {
  return iso(Date.parse(showStartIso) - 26 * HOUR);
}

/** 소명 기한 기본값 = max(요청 + 24시간, min(요청 + 3일, 취소 마감 − 6시간))(forensic-replay §6.7.5) */
export function defaultAppealDue(requestIso: string, cancelDeadlineIso: string): string {
  const r = Date.parse(requestIso);
  const due = Math.min(r + 3 * DAY, Date.parse(cancelDeadlineIso) - 6 * HOUR);
  return iso(Math.max(due, r + DAY));
}

/** 기한이 '취소 마감 − 6시간' 안이면 참(표 취소를 고를 여지가 남는다). 거짓이면 화면이 보내기 전에 알린다 */
export function appealDueLeavesCancel(dueIso: string, cancelDeadlineIso: string): boolean {
  return Date.parse(dueIso) <= Date.parse(cancelDeadlineIso) - 6 * HOUR;
}

export type DeadlineTone = 'ok' | 'warning' | 'danger' | 'passed';

function spanText(ms: number): string {
  if (ms < HOUR) return '1시간 미만';
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  return days > 0 ? (hours > 0 ? `${days}일 ${hours}시간` : `${days}일`) : `${hours}시간`;
}

/** 취소 마감까지 남은 시간(CMP-040 cancel-deadline). 12시간 [가정] 이하 warning, 2시간 [가정] 이하 danger */
export function cancelDeadlineNotice(nowIso: string, deadlineIso: string): { tone: DeadlineTone; text: string; short: string } {
  const left = Date.parse(deadlineIso) - Date.parse(nowIso);
  if (left <= 0) return { tone: 'passed', text: '취소 마감이 지났습니다', short: '지남' };
  const span = spanText(left);
  // 단계는 화면에 보이는 시간 값(내림한 시간)으로 정한다. '12시간 남음'이면 warning, '2시간 남음'이면 danger다(12시간 30분이 ok로 보이지 않게)
  const shownHours = Math.floor(left / HOUR);
  const tone: DeadlineTone = shownHours <= 2 ? 'danger' : shownHours <= 12 ? 'warning' : 'ok';
  return { tone, text: `취소 마감까지 ${span} 남았습니다`, short: `${span} 남음` };
}

/** 소명 기한까지 남은 시간(CMP-040 hours) '남은 시간 72시간' */
export function remainingHoursText(nowIso: string, dueIso: string): string {
  const left = Date.parse(dueIso) - Date.parse(nowIso);
  if (left <= 0) return '기한 지남';
  return `남은 시간 ${Math.floor(left / HOUR)}시간`;
}

/** '구매 27 / 한도 4'(forensic-replay §6.7.3) */
export function purchaseVsLimit(purchases: number, limit: number): string {
  return `구매 ${purchases} / 한도 ${limit}`;
}

/** 서버가 가린 IP 표시값인지(IPv4 /24, IPv6 /48, authz-matrix §4.3 5) */
export function isMaskedIpLabel(label: string): boolean {
  return /^(\d{1,3}\.){3}0\/24$/.test(label) || /^[0-9a-f]{1,4}(:[0-9a-f]{1,4}){0,2}::\/48$/i.test(label);
}
