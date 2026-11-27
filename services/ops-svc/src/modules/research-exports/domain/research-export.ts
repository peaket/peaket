// F-04-19 연구 갈래 내보내기의 순수 모델(동결 로컬, LCH-330).
// 정본: docs/features/forensic-replay.md §4.2·§6.3·§6.6·§7.2·§8(FX-T10·T17·T22),
// docs/security/asvs/forensic-replay.md 1.2.4·2.2.3·2.4.1·8.2.1·8.2.2·8.2.3·13.2.2·14.2.4·16.2.1·16.2.5·16.3.3.
// 이 파일은 저장소·HTTP·시계를 모른다. 서비스와 시험이 같은 값을 쓰도록 계산만 둔다.

export const RESEARCH_WINDOW_MS = 1_800_000;
export const RESEARCH_DAILY_LIMIT = 5;
export const RESEARCH_EXPORT_TTL_MS = 1_800_000;
export const RESEARCH_RETENTION_MS = 90 * 86_400_000;
export const RESEARCH_DENIAL_ALERT_THRESHOLD = 3;
export const RESEARCH_DENIAL_ALERT_WINDOW_MS = 600_000;
export const RESEARCH_MAX_FILE_BYTES = 200 * 1024 * 1024;
export const RESEARCH_COLUMNS = [
  't_ms', 'kind', 'seat', 'section', 'session', 'result', 'retry', 'latency_ms',
  'first_hold_ms', 'entropy', 'net_type', 'asn', 'device_group', 'bot_tier', 'member', 'post_seat',
] as const;
export type ResearchColumn = (typeof RESEARCH_COLUMNS)[number];
export type ResearchExportStatus = 'PENDING' | 'READY' | 'FAILED';
export type ResearchExportOutcome = 'REQUESTED' | 'READY' | 'RECEIVED' | 'DENIED' | 'FAILED';
export type ResearchFileProblem = 'TOO_LARGE' | 'INVALID_ENVELOPE' | 'INVALID_COLUMNS' | 'INVALID_ROW_COUNT';

export interface ResearchActor {
  accountId: string;
  sessionId: string;
  role: string;
  designations: readonly string[];
}

export interface ResearchExportRecord {
  exportId: string;
  eventId: string;
  createdBy: string;
  createdBySessionId: string;
  createdByRole: string;
  fromMs: number;
  toMs: number;
  reason: string;
  allowlistVersion: string;
  keyVersion: string;
  status: ResearchExportStatus;
  createdAtMs: number;
  readyAtMs: number | null;
  expiresAtMs: number;
  rowCount: number;
  columns: readonly ResearchColumn[];
  failureType: string | null;
  saleEndsAtMs: number;
}

export interface ResearchWindowCheck {
  fromMs: number;
  toMs: number;
  saleEndsAtMs: number;
  nowMs: number;
}
export type ResearchWindowProblem = 'WINDOW_INVALID' | 'RETENTION_ENDED';

export function checkResearchWindow(i: ResearchWindowCheck): ResearchWindowProblem | null {
  const { fromMs, toMs, saleEndsAtMs, nowMs } = i;
  if (!Number.isInteger(fromMs) || !Number.isInteger(toMs)) return 'WINDOW_INVALID';
  if (fromMs < 0 || fromMs >= toMs || toMs > RESEARCH_WINDOW_MS) return 'WINDOW_INVALID';
  if (!Number.isFinite(saleEndsAtMs) || !Number.isFinite(nowMs)) return 'WINDOW_INVALID';
  if (nowMs > saleEndsAtMs + RESEARCH_RETENTION_MS) return 'RETENTION_ENDED';
  return null;
}

export function researchDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function researchQuotaExceeded(createdToday: number): boolean {
  return createdToday >= RESEARCH_DAILY_LIMIT;
}

export function researchDesignationProblem(designations: readonly string[]): 'pseudonym-handler-required' | null {
  if (designations.includes('PSEUDONYM_HANDLER') && !designations.includes('FRAUD_INVESTIGATOR')) return null;
  return 'pseudonym-handler-required';
}

export function researchExportSessionAllowed(r: ResearchExportRecord, a: ResearchActor): boolean {
  return r.createdBy === a.accountId && r.createdBySessionId === a.sessionId;
}

export function researchFetchAllowed(headers: { mode?: string; site?: string }): boolean {
  const mode = (headers.mode ?? '').toLowerCase();
  const site = (headers.site ?? '').toLowerCase();
  return (mode === 'cors' || mode === 'same-origin') && site === 'same-origin';
}

export function researchOutputColumns(): readonly ResearchColumn[] {
  return RESEARCH_COLUMNS;
}

export function researchMaskExpression(column: ResearchColumn): string {
  switch (column) {
    case 'entropy':
      return "toFloat32('nan')";
    case 'net_type':
    case 'member':
    case 'post_seat':
      return 'toUInt8(0)';
    case 'asn':
    case 'device_group':
      return 'toUInt32(0)';
    default:
      return column;
  }
}

/** SELECT 목록 16개. `session`은 구매 세션 가명을 파일 안 번호로 바꾸는 창 함수다. */
export function researchSelectList(): readonly string[] {
  return RESEARCH_COLUMNS.map((column) => {
    if (column === 'session') return 'dense_rank() OVER (ORDER BY session_ref) AS session';
    return `${researchMaskExpression(column)} AS ${column}`;
  });
}

export function researchFileProblem(i: {
  byteLength: number;
  head: string;
  tail: string;
  columns: readonly string[];
  rowCount: number;
}): ResearchFileProblem | null {
  if (!Number.isInteger(i.byteLength) || i.byteLength < 0) return 'INVALID_ENVELOPE';
  if (i.byteLength > RESEARCH_MAX_FILE_BYTES) return 'TOO_LARGE';
  if (i.byteLength < 12 || i.head !== 'ARROW1' || i.tail !== 'ARROW1') return 'INVALID_ENVELOPE';
  if (i.columns.length !== RESEARCH_COLUMNS.length || i.columns.some((c, n) => c !== RESEARCH_COLUMNS[n])) return 'INVALID_COLUMNS';
  if (!Number.isInteger(i.rowCount) || i.rowCount < 0) return 'INVALID_ROW_COUNT';
  return null;
}

export function researchQuery(i: { eventId: string; fromMs: number; toMs: number }): {
  sql: string;
  params: { eventId: string; fromMs: number; toMs: number };
} {
  // 실제 ClickHouse 실행은 미실행이다. 문장은 고정이고 사용자 값은 매개변수로만 보낸다.
  // 표마다 한 번만 읽고, 공통 사건 모양으로 맞춘 뒤 마지막 SELECT가 researchSelectList()를 쓴다.
  const select = researchSelectList().join(',\n       ');
  const sql = `WITH
  queue AS (
    SELECT event_id, t_ms, toUInt8(kind) AS kind, toUInt32(seat) AS seat, toUInt16(section) AS section,
           session_ref, toUInt8(result) AS result, toUInt8(retry) AS retry, toUInt16(latency_ms) AS latency_ms,
           toUInt32(first_hold_ms) AS first_hold_ms, toUInt8(bot_tier) AS bot_tier
    FROM silver.slv_queue_entry
  ),
  purchase AS (
    SELECT event_id, t_ms, toUInt8(kind) AS kind, toUInt32(seat) AS seat, toUInt16(section) AS section,
           session_ref, toUInt8(result) AS result, toUInt8(retry) AS retry, toUInt16(latency_ms) AS latency_ms,
           toUInt32(first_hold_ms) AS first_hold_ms, toUInt8(bot_tier) AS bot_tier
    FROM silver.slv_purchase_session
  ),
  hold AS (
    SELECT event_id, t_ms, toUInt8(kind) AS kind, toUInt32(seat) AS seat, toUInt16(section) AS section,
           session_ref, toUInt8(result) AS result, toUInt8(retry) AS retry, toUInt16(latency_ms) AS latency_ms,
           toUInt32(first_hold_ms) AS first_hold_ms, toUInt8(bot_tier) AS bot_tier
    FROM silver.slv_hold_attempt
  ),
  seat_change AS (
    SELECT event_id, t_ms, toUInt8(kind) AS kind, toUInt32(seat) AS seat, toUInt16(section) AS section,
           session_ref, toUInt8(result) AS result, toUInt8(retry) AS retry, toUInt16(latency_ms) AS latency_ms,
           toUInt32(first_hold_ms) AS first_hold_ms, toUInt8(bot_tier) AS bot_tier
    FROM silver.slv_seat_change
  ),
  payment AS (
    SELECT event_id, t_ms, toUInt8(kind) AS kind, toUInt32(seat) AS seat, toUInt16(section) AS section,
           session_ref, toUInt8(result) AS result, toUInt8(retry) AS retry, toUInt16(latency_ms) AS latency_ms,
           toUInt32(first_hold_ms) AS first_hold_ms, toUInt8(bot_tier) AS bot_tier
    FROM silver.slv_payment_attempt
  ),
  ticket AS (
    SELECT event_id, t_ms, toUInt8(kind) AS kind, toUInt32(seat) AS seat, toUInt16(section) AS section,
           session_ref, toUInt8(result) AS result, toUInt8(retry) AS retry, toUInt16(latency_ms) AS latency_ms,
           toUInt32(first_hold_ms) AS first_hold_ms, toUInt8(bot_tier) AS bot_tier
    FROM silver.slv_ticket
  ),
  trust_label AS (
    SELECT event_id, t_ms, toUInt8(kind) AS kind, toUInt32(seat) AS seat, toUInt16(section) AS section,
           session_ref, toUInt8(result) AS result, toUInt8(retry) AS retry, toUInt16(latency_ms) AS latency_ms,
           toUInt32(first_hold_ms) AS first_hold_ms, toUInt8(bot_tier) AS bot_tier
    FROM silver.slv_trust_label
  ),
  events AS (
    SELECT * FROM queue UNION ALL SELECT * FROM purchase UNION ALL SELECT * FROM hold UNION ALL
    SELECT * FROM seat_change UNION ALL SELECT * FROM payment UNION ALL SELECT * FROM ticket UNION ALL
    SELECT * FROM trust_label
  )
SELECT ${select}
FROM events
WHERE event_id = {eventId:String} AND t_ms >= {fromMs:Int64} AND t_ms < {toMs:Int64}
SETTINGS output_format_arrow_compression_method = 'none', output_format_arrow_low_cardinality_as_dictionary = 0
FORMAT ArrowStream`;
  return { sql, params: { eventId: i.eventId, fromMs: i.fromMs, toMs: i.toMs } };
}

export function recentDenialCount(atMsList: readonly number[], nowMs: number, windowMs = RESEARCH_DENIAL_ALERT_WINDOW_MS): number {
  return atMsList.filter((at) => at >= nowMs - windowMs && at <= nowMs).length;
}

export function denialAlertDue(count: number): boolean {
  return count === RESEARCH_DENIAL_ALERT_THRESHOLD;
}

export interface PseudonymizationUsage {
  exportId: string;
  fromMs: number;
  toMs: number;
  columns: readonly string[];
  rowCount: number;
  outcome: ResearchExportOutcome;
  problemType?: string;
}
export interface PseudonymizationLogRow {
  eventId: string;
  purpose: 'SCIENTIFIC_RESEARCH';
  items: string;
  keyVersion: string;
  usage: PseudonymizationUsage;
  processedFromMs: number;
  destroyDueAtMs: number;
}

export function pseudonymizationLogRow(i: {
  record: ResearchExportRecord;
  saleEndsAtMs: number;
  outcome: ResearchExportOutcome;
  rowCount?: number;
  problemType?: string;
  nowMs: number;
}): PseudonymizationLogRow {
  const usage: PseudonymizationUsage = {
    exportId: i.record.exportId,
    fromMs: i.record.fromMs,
    toMs: i.record.toMs,
    columns: i.record.columns,
    rowCount: i.rowCount ?? i.record.rowCount,
    outcome: i.outcome,
  };
  if ((i.outcome === 'DENIED' || i.outcome === 'FAILED') && i.problemType !== undefined) usage.problemType = i.problemType;
  return {
    eventId: i.record.eventId,
    purpose: 'SCIENTIFIC_RESEARCH',
    items: '회차 가명 세션 번호, 구역·좌석, 단계 시각·결과·응답 지연, 사후 판정 등급',
    keyVersion: i.record.keyVersion,
    usage,
    processedFromMs: i.nowMs,
    destroyDueAtMs: i.saleEndsAtMs + RESEARCH_RETENTION_MS,
  };
}

export function researchAuditRecord(i: {
  record: ResearchExportRecord;
  outcome: ResearchExportOutcome;
  problemType?: string;
  actorRole: string;
  nowMs: number;
}): { recordType: 'RESEARCH_EXPORT'; recordId: string; payload: Record<string, unknown>; nowMs: number } {
  const action = i.outcome === 'REQUESTED' ? 'CREATE' : i.outcome === 'RECEIVED' ? 'RECEIVE' : i.outcome === 'DENIED' ? 'DENY' : 'BUILD_FAILED';
  const payload: Record<string, unknown> = {
    action,
    accountId: i.record.createdBy,
    role: i.actorRole,
    eventId: i.record.eventId,
    fromMs: i.record.fromMs,
    toMs: i.record.toMs,
    columns: i.record.columns,
    rowCount: i.outcome === 'RECEIVED' ? i.record.rowCount : 0,
    reason: i.record.reason,
    outcome: i.outcome,
    atMs: i.nowMs,
  };
  if (i.problemType !== undefined) payload.problemType = i.problemType;
  return { recordType: 'RESEARCH_EXPORT', recordId: i.record.exportId, payload, nowMs: i.nowMs };
}

export interface ResearchWiring {
  enabled: boolean;
  config?: { allowlistVersion: string; approvedReviewVersions: readonly string[]; keyVersion: string };
}

/** main.ts의 다섯 환경 값 조립. 하나라도 없으면 연구 경로를 열지 않는다(404). */
export function researchWiringFromEnv(env: Record<string, string | undefined>): ResearchWiring {
  const url = env.PEAKET_RESEARCH_CLICKHOUSE_URL;
  const user = env.PEAKET_RESEARCH_CLICKHOUSE_USER;
  const allowlistVersion = env.PEAKET_RESEARCH_ALLOWLIST_VERSION;
  const approved = env.PEAKET_RESEARCH_APPROVED_REVIEW_VERSIONS;
  const keyVersion = env.PEAKET_RESEARCH_PSEUDONYM_KEY_VERSION;
  if (!url || !user || !allowlistVersion || !approved || !keyVersion) return { enabled: false };
  return {
    enabled: true,
    config: {
      allowlistVersion,
      approvedReviewVersions: approved.split(',').map((v) => v.trim()).filter(Boolean),
      keyVersion,
    },
  };
}
