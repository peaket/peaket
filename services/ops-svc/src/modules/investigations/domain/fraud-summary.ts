// F-04-19 부정 예매 사건 집계(동결 로컬, LCH-330).
// 정본: docs/features/analytics.md §3.2·§5.2·§6.3·§11(A-T24), docs/features/forensic-replay.md §6.6(FX-T17).
// 사람 단위 행을 넘기지 않는다. 출력은 회차 × 사유 범주의 수와 지표 32의 분자·분모다.
import type { FraudCaseRecord, FraudReasonCategory } from './investigation.js';

export const FRAUD_SUMMARY_MIN_CELL = 5;
export const FRAUD_SUMMARY_OTHER = 'OTHER' as const;
export type FraudSummaryReason = FraudReasonCategory | typeof FRAUD_SUMMARY_OTHER;

export interface FraudSummaryRow {
  eventId: string;
  reasonCategory: FraudSummaryReason;
  caseCount: number;
  appealRequestedAccounts: number;
  appealAcceptedAccounts: number;
  objectionAcceptedAccounts: number;
  actionedAccounts: number;
  actionedTickets: number;
}

const ORDER: readonly FraudReasonCategory[] = ['MACRO_BOT', 'QUEUE_BYPASS', 'CAPTCHA_BYPASS', 'ACCOUNT_LENDING', 'LIMIT_EVASION'];

interface Group {
  eventId: string;
  reasonCategory: FraudSummaryReason;
  caseCount: number;
  accounts: Map<string, { ticketCount: number; appealRequested: boolean; appealAccepted: boolean; objectionAccepted: boolean; actioned: boolean }>;
}

function activeMembers(c: FraudCaseRecord) {
  return c.members.filter((m) => m.removedAtMs === null || m.removedAtMs === undefined);
}

function addToGroup(g: Group, c: FraudCaseRecord): void {
  g.caseCount += 1;
  for (const m of activeMembers(c)) {
    const prev = g.accounts.get(m.accountId);
    const next = {
      ticketCount: Math.max(prev?.ticketCount ?? 0, m.ticketCount),
      appealRequested: (prev?.appealRequested ?? false) || m.appealRequestedAtMs !== null && m.appealRequestedAtMs !== undefined,
      appealAccepted: (prev?.appealAccepted ?? false) || m.appealResult === 'ACCEPTED',
      objectionAccepted: (prev?.objectionAccepted ?? false) || m.objectionResult === 'ACCEPTED',
      actioned: (prev?.actioned ?? false) || (m.actionNotifiedAtMs !== null && m.actionNotifiedAtMs !== undefined),
    };
    g.accounts.set(m.accountId, next);
  }
}

function rowOf(g: Group): FraudSummaryRow {
  let appealRequested = 0;
  let appealAccepted = 0;
  let objectionAccepted = 0;
  let actioned = 0;
  let tickets = 0;
  for (const a of g.accounts.values()) {
    if (a.appealRequested) appealRequested += 1;
    if (a.appealAccepted) appealAccepted += 1;
    if (a.objectionAccepted) objectionAccepted += 1;
    if (a.actioned) {
      actioned += 1;
      tickets += a.ticketCount;
    }
  }
  return {
    eventId: g.eventId,
    reasonCategory: g.reasonCategory,
    caseCount: g.caseCount,
    appealRequestedAccounts: appealRequested,
    appealAcceptedAccounts: appealAccepted,
    objectionAcceptedAccounts: objectionAccepted,
    actionedAccounts: actioned,
    actionedTickets: tickets,
  };
}

export function fraudSummaryRows(cases: readonly FraudCaseRecord[], o: { minCell?: number } = {}): FraudSummaryRow[] {
  const minCell = o.minCell ?? FRAUD_SUMMARY_MIN_CELL;
  if (!Number.isFinite(minCell) || minCell <= 0) throw new RangeError('minCell은 0보다 큰 수여야 합니다');
  const groups = new Map<string, Group>();
  const eventOrder: string[] = [];
  for (const c of cases) {
    const key = `${c.eventId}\u0000${c.reasonCategory}`;
    let g = groups.get(key);
    if (!g) {
      g = { eventId: c.eventId, reasonCategory: c.reasonCategory, caseCount: 0, accounts: new Map() };
      groups.set(key, g);
      if (!eventOrder.includes(c.eventId)) eventOrder.push(c.eventId);
    }
    addToGroup(g, c);
  }

  const out: FraudSummaryRow[] = [];
  for (const eventId of eventOrder) {
    const own = [...groups.values()].filter((g) => g.eventId === eventId);
    const kept = own.filter((g) => g.accounts.size >= minCell);
    const small = own.filter((g) => g.accounts.size < minCell);
    kept.sort((a, b) => ORDER.indexOf(a.reasonCategory as FraudReasonCategory) - ORDER.indexOf(b.reasonCategory as FraudReasonCategory));
    for (const g of kept) out.push(rowOf(g));
    if (small.length > 0) {
      const merged: Group = { eventId, reasonCategory: FRAUD_SUMMARY_OTHER, caseCount: 0, accounts: new Map() };
      for (const g of small) {
        merged.caseCount += g.caseCount;
        for (const [accountId, a] of g.accounts) {
          const prev = merged.accounts.get(accountId);
          merged.accounts.set(accountId, {
            ticketCount: Math.max(prev?.ticketCount ?? 0, a.ticketCount),
            appealRequested: (prev?.appealRequested ?? false) || a.appealRequested,
            appealAccepted: (prev?.appealAccepted ?? false) || a.appealAccepted,
            objectionAccepted: (prev?.objectionAccepted ?? false) || a.objectionAccepted,
            actioned: (prev?.actioned ?? false) || a.actioned,
          });
        }
      }
      out.push(rowOf(merged));
    }
  }
  return out;
}

export function fraudSummaryJsonLines(rows: readonly FraudSummaryRow[]): string {
  return rows.map((r) => `${JSON.stringify(r)}\n`).join('');
}

export function fraudAppealAcceptance(rows: readonly FraudSummaryRow[]): {
  numerator: number;
  denominator: number;
  rate: number | null;
} {
  const numerator = rows.reduce((n, r) => n + r.appealAcceptedAccounts, 0);
  const denominator = rows.reduce((n, r) => n + r.appealRequestedAccounts, 0);
  return { numerator, denominator, rate: denominator === 0 ? null : numerator / denominator };
}
