// SCR-030 운영 명령 목록·상세·승인 화면 모델(BAT-465 GAT-300·GAT-310, d5 §7.3).
// API 값을 화면 표기로 바꾸는 순수 함수만 둔다. 실제 호출은 ui/ConnectedPage.tsx가 @peaket/api-client로 한다.

export type CommandStateValue =
  | 'DRAFTED'
  | 'DRY_RUN'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'DISPATCHED'
  | 'ACKED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'REVERT_PENDING'
  | 'REVERTED'
  | 'AUTO_EXPIRED';

export interface RawCommand {
  commandId?: string;
  type?: string;
  state?: CommandStateValue;
  reason?: string;
  requestedBy?: { adminAccountId?: string; displayName?: string | null; role?: string };
  eventId?: string | null;
  params?: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
  approvals?: readonly string[];
  attempts?: number;
  lastError?: string | null;
  executedAt?: string | null;
  canApprove?: boolean;
}

export interface CommandRow {
  commandId: string;
  type: string;
  state: CommandStateValue;
  reason: string;
  requestedBy: { adminAccountId: string; displayName: string | null; role: string };
  eventId?: string;
  createdAt: string;
  updatedAt: string;
  approvals: readonly string[];
  attempts: number;
  lastError?: string;
  executedAt?: string;
  canApprove: boolean;
}

export interface CommandPage {
  items: CommandRow[];
  nextCursor: string | null;
}

const KST = 'Asia/Seoul';

/** 목록 응답을 화면 행으로. 명령 ID가 없는 항목은 버린다 */
export function mapCommandList(raw: { items?: readonly RawCommand[]; nextCursor?: string | null }): CommandPage {
  const items = (raw.items ?? []).flatMap((c) => {
    if (!c.commandId) return [];
    return [
      {
        commandId: c.commandId,
        type: c.type ?? 'LOG_LEVEL',
        state: c.state ?? 'DRAFTED',
        reason: c.reason ?? '',
        requestedBy: {
          adminAccountId: c.requestedBy?.adminAccountId ?? '',
          displayName: c.requestedBy?.displayName ?? null,
          role: c.requestedBy?.role ?? '',
        },
        ...(c.eventId ? { eventId: c.eventId } : {}),
        createdAt: c.createdAt ?? '',
        updatedAt: c.updatedAt ?? '',
        approvals: c.approvals ?? [],
        attempts: c.attempts ?? 0,
        ...(c.lastError ? { lastError: c.lastError } : {}),
        ...(c.executedAt ? { executedAt: c.executedAt } : {}),
        canApprove: c.canApprove === true,
      } satisfies CommandRow,
    ];
  });
  return { items, nextCursor: raw.nextCursor ?? null };
}

export function stateLabel(state: CommandStateValue): string {
  switch (state) {
    case 'DRAFTED':
      return '작성됨';
    case 'DRY_RUN':
      return '모의 실행';
    case 'PENDING_APPROVAL':
      return '승인 대기';
    case 'APPROVED':
      return '승인됨';
    case 'REJECTED':
      return '반려됨';
    case 'DISPATCHED':
      return '실행 중';
    case 'ACKED':
      return '적용 확인';
    case 'SUCCEEDED':
      return '성공';
    case 'FAILED':
      return '실패';
    case 'REVERT_PENDING':
      return '되돌리기 승인 대기';
    case 'REVERTED':
      return '되돌림';
    case 'AUTO_EXPIRED':
      return '자동 만료';
  }
}

export function stateTone(state: CommandStateValue): 'success' | 'danger' | 'warning' | 'outline' {
  if (state === 'SUCCEEDED' || state === 'ACKED' || state === 'REVERTED') return 'success';
  if (state === 'FAILED' || state === 'REJECTED') return 'danger';
  if (state === 'PENDING_APPROVAL' || state === 'DISPATCHED' || state === 'REVERT_PENDING') return 'warning';
  return 'outline';
}

export function typeLabel(type: string): string {
  switch (type) {
    case 'EVENT_CANCEL':
      return '회차 취소·일괄 환불';
    case 'SCALE_CHANGE':
      return '회차 규모 올리기';
    case 'KILL_SWITCH':
      return '판매 일시정지';
    case 'ADMISSION_PAUSE':
      return '입장 일시정지';
    case 'ADMISSION_TARGET':
      return '동시 입장 목표';
    case 'BOT_LEVEL':
      return '봇 판정 강도';
    case 'DEGRADED_MODE':
      return 'Degraded 전환';
    case 'BLOCK_ASN_IP':
      return '대역 차단';
    case 'LOBBY_BANNER':
      return '대기실 공지';
    case 'LOG_LEVEL':
      return '로그 레벨';
    case 'FEATURE_OFF':
      return '기능 끄기';
    case 'TAKEDOWN':
      return '게시물 차단';
    case 'AUTOMATION_STOP':
      return '자동화 정지';
    case 'PG_ASSIGN':
      return '결제사 지정';
    case 'SALE_STOP':
      return '판매 중지';
    case 'SALE_RESUME':
      return '판매 재개';
    default:
      return type;
  }
}

/** 승인 대기·상태·유형·검색어로 거른다. 검색어는 사유·명령 ID·유형 이름을 본다 */
export function filterCommands(
  items: readonly CommandRow[],
  f: { state?: CommandStateValue | 'ALL'; type?: string | 'ALL'; query?: string },
): CommandRow[] {
  const q = (f.query ?? '').trim().toLowerCase();
  return items.filter((c) => {
    if (f.state && f.state !== 'ALL' && c.state !== f.state) return false;
    if (f.type && f.type !== 'ALL' && c.type !== f.type) return false;
    if (q === '') return true;
    return c.reason.toLowerCase().includes(q) || c.commandId.toLowerCase().includes(q) || typeLabel(c.type).toLowerCase().includes(q);
  });
}

/** 실패한 명령만 재시도할 수 있다(서버도 같은 규칙) */
export function isRetryable(row: Pick<CommandRow, 'state'>): boolean {
  return row.state === 'FAILED';
}

/** 요청자와 다른 계정만 승인할 수 있다. 서버의 canApprove를 그대로 쓴다 */
export function canApprove(row: Pick<CommandRow, 'canApprove'>): boolean {
  return row.canApprove;
}

/** KST 날짜·시각 '10/15(목) 14:20 KST'. 값이 없거나 잘못되면 '—' */
export function formatKstDateTime(iso: string | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const parts = new Intl.DateTimeFormat('ko-KR', { timeZone: KST, month: 'numeric', day: 'numeric', weekday: 'short' }).formatToParts(new Date(t));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const time = new Intl.DateTimeFormat('ko-KR', { timeZone: KST, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t));
  return `${get('month')}/${get('day')}(${get('weekday')}) ${time} KST`;
}
