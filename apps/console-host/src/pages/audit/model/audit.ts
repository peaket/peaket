// SCR-031 감사 로그·인시던트 리플레이 모델(F-03-7).
// 정본: docs/design/d5-screen-blueprint.md §7.4, docs/features/control-tower.md §7(감사 원본·체크포인트·공개 앵커),
// openapi CommandState·AuditCheckpoint·AuditCheckpointVerification. 감사 원장 행 조회 경로가 아직 없어
// 명령 원장(GET /v1/ops/commands)을 행의 원천으로 쓴다(계획 1-1, 남은 위험 1). 정본 값은 옮겨 적지 않고 자리만 가리킨다.

export type AuditRole = 'viewer' | 'operator' | 'commander' | (string & {});
export type AuditLayout = 'phone' | 'tablet' | 'desktop';
export type AuditActorFilter = 'ALL' | 'HUMAN' | 'SYSTEM' | 'RUNBOOK';

/** 공개 앵커 게시 지연 기준(d5 §7.4 '공개 앵커 지연', 6시간 [가정]) */
export const ANCHOR_LATE_MS = 6 * 60 * 60_000;

export type CommandTypeLabel = string;

const TYPE_LABELS: Record<string, string> = {
  ADMISSION_TARGET: '동시 입장 목표',
  ADMISSION_PAUSE: '입장 일시정지',
  KILL_SWITCH: '판매 일시정지',
  BLOCK_ASN_IP: 'ASN·IP 대역 차단',
  BOT_LEVEL: '봇 판정 강도',
  DEGRADED_MODE: 'Degraded Mode',
  LOBBY_BANNER: '대기실 공지',
  LOG_LEVEL: '로그 레벨',
  FEATURE_OFF: '비핵심 기능 끄기',
  TAKEDOWN: '게시물 노출 차단',
  AUTOMATION_STOP: '자동화 정지',
  PG_ASSIGN: '결제사 지정',
  EVENT_CANCEL: '회차 취소',
  EVENT_REFUND_PAUSE: '일괄 환불 멈춤',
  EVENT_REFUND_RESUME: '일괄 환불 재개',
  SCALE_CHANGE: '회차 규모 올리기',
  SALE_STOP: '판매 중지',
  SALE_RESUME: '판매 재개',
};

const STATE_LABELS: Record<string, string> = {
  DRAFTED: '작성',
  DRY_RUN: '모의',
  PENDING_APPROVAL: '승인 대기',
  APPROVED: '승인됨',
  REJECTED: '반려',
  DISPATCHED: '전파 중',
  ACKED: '적용 확인',
  SUCCEEDED: '완료',
  FAILED: '실패',
  REVERT_PENDING: '재개 승인 대기',
  REVERTED: '되돌림',
  AUTO_EXPIRED: '자동 만료',
};

export interface RawAuditCommand {
  commandId?: unknown;
  type?: unknown;
  state?: unknown;
  reason?: unknown;
  eventId?: unknown;
  requestedBy?: { adminAccountId?: unknown; displayName?: unknown; role?: unknown } | null;
  approvals?: unknown;
  dryRun?: {
    approvalMode?: unknown;
    reauthRequired?: unknown;
    counted?: unknown;
    predicted?: unknown;
    unavailable?: unknown;
  } | null;
  createdAt?: unknown;
  ackedAt?: unknown;
  executedAt?: unknown;
  lastError?: unknown;
}

export interface AuditRow {
  commandId: string;
  at: string;
  atMs: number;
  actor: string;
  actorRole: string;
  type: string;
  typeLabel: string;
  reason: string;
  approver: string;
  dryRun: { approval: 'none' | 'one' | 'two' | 'unknown'; reauth: boolean; counted: number; predicted: number; unavailable: number };
  result: string;
  state: string;
  eventId?: string;
  createdAtMs?: number;
  ackedAtMs?: number;
  executedAtMs?: number;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

/** 명령 원장 한 행 → 감사 행(d5 §7.4 표의 칸). 값이 없으면 '—'로 두고 0으로 만들지 않는다 */
export function auditRowOf(raw: RawAuditCommand): AuditRow {
  const state = text(raw.state);
  const requestedBy = raw.requestedBy ?? undefined;
  const system = state === 'AUTO_EXPIRED';
  const runbook = !system && text(requestedBy?.role) === 'RUNBOOK';
  const actor = system ? '시스템' : runbook ? text(requestedBy?.displayName) || '런북 CLI' : text(requestedBy?.displayName) || text(requestedBy?.role) || '—';
  const actorRole = system ? 'SYSTEM' : runbook ? 'RUNBOOK' : text(requestedBy?.role) || '—';
  const rawApprovals = Array.isArray(raw.approvals) ? raw.approvals : [];
  const approver = rawApprovals.length > 0 ? rawApprovals.map((x) => text(x) || '—').join(', ') : '—';
  const mode = text(raw.dryRun?.approvalMode);
  const approval = mode === 'NONE' ? 'none' : mode === 'ONE' ? 'one' : mode === 'TWO' ? 'two' : 'unknown';
  const at = text(raw.ackedAt) || text(raw.executedAt) || text(raw.createdAt);
  const atMs = Number.isFinite(Date.parse(at)) ? Date.parse(at) : 0;
  const ackedAt = text(raw.ackedAt);
  const executedAt = text(raw.executedAt);
  const createdAt = text(raw.createdAt);
  const type = text(raw.type);
  return {
    commandId: text(raw.commandId),
    at,
    atMs,
    actor,
    actorRole,
    type,
    typeLabel: TYPE_LABELS[type] ?? (type || '—'),
    reason: text(raw.reason),
    approver,
    dryRun: {
      approval,
      reauth: raw.dryRun?.reauthRequired === true,
      counted: count(raw.dryRun?.counted),
      predicted: count(raw.dryRun?.predicted),
      unavailable: count(raw.dryRun?.unavailable),
    },
    result: STATE_LABELS[state] ?? (state || '—'),
    state,
    ...(text(raw.eventId) ? { eventId: text(raw.eventId) } : {}),
    ...(Number.isFinite(Date.parse(createdAt)) ? { createdAtMs: Date.parse(createdAt) } : {}),
    ...(Number.isFinite(Date.parse(ackedAt)) ? { ackedAtMs: Date.parse(ackedAt) } : {}),
    ...(Number.isFinite(Date.parse(executedAt)) ? { executedAtMs: Date.parse(executedAt) } : {}),
  };
}

export function auditRowsOf(list: readonly RawAuditCommand[]): AuditRow[] {
  return list.map(auditRowOf);
}

export interface AuditFilter {
  fromMs?: number;
  actor?: AuditActorFilter;
  type?: string | 'ALL';
  query?: string;
}

export function filterAuditRows(rows: readonly AuditRow[], f: AuditFilter = {}): AuditRow[] {
  const q = (f.query ?? '').trim().toLowerCase();
  return rows.filter((r) => {
    if (f.fromMs !== undefined && r.atMs < f.fromMs) return false;
    if (f.actor === 'SYSTEM' && r.actorRole !== 'SYSTEM') return false;
    if (f.actor === 'RUNBOOK' && r.actorRole !== 'RUNBOOK') return false;
    if (f.actor === 'HUMAN' && (r.actorRole === 'SYSTEM' || r.actorRole === 'RUNBOOK')) return false;
    if (f.type && f.type !== 'ALL' && r.type !== f.type) return false;
    if (q !== '') {
      const hay = `${r.commandId} ${r.reason} ${r.eventId ?? ''} ${r.typeLabel}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export interface RawCheckpoint {
  checkpointId?: unknown;
  fromSeq?: unknown;
  toSeq?: unknown;
  createdAt?: unknown;
  signature?: unknown;
  publishedAt?: unknown;
  no?: unknown;
  otsState?: unknown;
  kind?: unknown;
  reason?: unknown;
}

export interface ChainView {
  kind: 'empty' | 'verified' | 'pending' | 'late' | 'broken';
  lastNo: number | null;
  lastPublishedAt: string | null;
  anchor: 'none' | 'pending' | 'late';
  message: string;
}

const CHAIN_MESSAGES: Record<ChainView['kind'], string> = {
  empty: '감사 체크포인트가 아직 없습니다',
  verified: '감사 체인 검증됨',
  pending: '마지막 체크포인트가 아직 서명·게시되지 않았습니다',
  late: '공개 앵커 게시가 6시간 넘게 밀렸습니다',
  broken: '감사 체인 검증에 실패했습니다. 보안 사고로 기록합니다',
};

/** 체크포인트 목록(최신순)과 검증 결과 → 체인 배지·공개 앵커 띠 */
export function chainViewOf(
  checkpoints: readonly RawCheckpoint[],
  verifications: Readonly<Record<string, { valid?: unknown } | undefined>>,
  nowMs: number,
): ChainView {
  const latest = checkpoints[0];
  if (!latest) return { kind: 'empty', lastNo: null, lastPublishedAt: null, anchor: 'none', message: CHAIN_MESSAGES.empty };
  const id = text(latest.checkpointId);
  const publishedAt = text(latest.publishedAt);
  const createdAt = text(latest.createdAt);
  const no = typeof latest.no === 'number' ? latest.no : null;
  const v = id ? verifications[id] : undefined;
  const publishedAgeMs = publishedAt ? nowMs - Date.parse(publishedAt) : createdAt ? nowMs - Date.parse(createdAt) : 0;

  const anchor: ChainView['anchor'] =
    text(latest.signature) !== '' && (!publishedAt ? publishedAgeMs > ANCHOR_LATE_MS : false)
      ? 'late'
      : publishedAt && publishedAgeMs > ANCHOR_LATE_MS
        ? 'late'
        : text(latest.otsState) === 'PENDING'
          ? 'pending'
          : 'none';

  let kind: ChainView['kind'];
  if (v && v.valid === false) kind = 'broken';
  else if (text(latest.signature) === '' || publishedAt === '') kind = 'pending';
  else if (publishedAgeMs > ANCHOR_LATE_MS) kind = 'late';
  else kind = 'verified';

  const message =
    kind === 'broken'
      ? CHAIN_MESSAGES.broken
      : anchor === 'late'
        ? `${CHAIN_MESSAGES.late}. 내부 5분 앵커와 1시간마다 하는 감사 체인 검증은 계속됩니다. SEV3로 알렸습니다.`
        : anchor === 'pending'
          ? '마지막 체크포인트의 공개 타임스탬프 증명이 비트코인 확정 전이라 대기 중입니다(보통 몇 시간). 그동안 검증 묶음에는 대기 중인 증명이 들어갑니다.'
          : CHAIN_MESSAGES[kind];
  return { kind, lastNo: no, lastPublishedAt: publishedAt || null, anchor, message };
}

export type ReplayKind = 'CHECKPOINT' | 'REQUEST' | 'APPROVAL' | 'DISPATCH' | 'ACK' | 'REVERT' | 'EXPIRE';

export interface ReplayEvent {
  atMs: number;
  kind: ReplayKind;
  label: string;
  detail?: string;
}

const KIND_ORDER: Record<ReplayKind, number> = { CHECKPOINT: 0, REQUEST: 1, APPROVAL: 2, DISPATCH: 3, ACK: 4, REVERT: 5, EXPIRE: 6 };

/** 명령 원장 행·체크포인트 → 시간축 사건. 사건 시각이 없는 승인은 그리지 않는다(0으로 만들지 않는다) */
export function replayTimelineOf(rows: readonly AuditRow[], checkpoints: readonly RawCheckpoint[]): ReplayEvent[] {
  const out: ReplayEvent[] = [];
  for (const cp of checkpoints) {
    const at = text(cp.createdAt);
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) continue;
    const no = typeof cp.no === 'number' ? `#${cp.no}` : '';
    out.push({ atMs, kind: 'CHECKPOINT', label: `체크포인트 ${no}`.trim(), ...(text(cp.reason) ? { detail: text(cp.reason) } : {}) });
  }
  for (const r of rows) {
    if (r.atMs > 0) out.push({ atMs: r.createdAtMs ?? r.atMs, kind: 'REQUEST', label: `${r.typeLabel} 접수`, detail: r.reason });
    if (r.state === 'ACKED' || r.state === 'REVERTED' || r.state === 'SUCCEEDED') {
      out.push({ atMs: r.ackedAtMs ?? r.executedAtMs ?? r.atMs, kind: 'ACK', label: '받는 쪽 적용 확인' });
    }
    if (r.state === 'REVERTED') out.push({ atMs: r.executedAtMs ?? r.atMs, kind: 'REVERT', label: '되돌림' });
    if (r.state === 'AUTO_EXPIRED') out.push({ atMs: r.executedAtMs ?? r.atMs, kind: 'EXPIRE', label: '자동 만료' });
    if (r.state === 'DISPATCHED') out.push({ atMs: r.executedAtMs ?? r.atMs, kind: 'DISPATCH', label: '받는 쪽으로 전파' });
  }
  return out.sort((a, b) => a.atMs - b.atMs || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

export function replayAt(timeline: readonly ReplayEvent[], tMs: number): { index: number; atMs: number; done: number } {
  let done = 0;
  for (const e of timeline) if (e.atMs <= tMs) done += 1;
  return { index: done - 1, atMs: tMs, done };
}

export interface ExportAvailability {
  bundle: boolean;
  raw: boolean;
  reason?: string;
}

export function exportAvailability(o: { role: AuditRole; layout: AuditLayout }): ExportAvailability {
  if (o.layout === 'phone') return { bundle: false, raw: false, reason: '검증 묶음 내보내기는 태블릿이나 데스크톱에서 합니다' };
  if (o.role !== 'commander') return { bundle: false, raw: false, reason: '검증 묶음 내보내기는 commander만 할 수 있습니다' };
  return { bundle: true, raw: false, reason: '원본 로그 내보내기 경로가 아직 서버에 없습니다(원천 연결 전)' };
}
