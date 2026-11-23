// 포트원 결제분 지급 실행·동기화·사후 대사(F-07-7 LCH-120, settlement §5.3·§5.5·§6·§11, ADR-0108, ADR-0370 결정 7·8, 계획 I-07·I-13·I-14·I-15).
// - 지급일 09:00 KST 실행 건(preparePortoneExecution): 계좌 변경 보류·수정 대기·판매 중지·계좌 대조 불일치 정산서는 수기 정산건을 취소하고 HELD로 빼며,
//   CS PORTONE_PAYOUT_EXECUTION(대상 = 묶음) 한 건의 detail에 뺀 정산서와 'commander 확인 필요'를 싣는다. 묶음 상태는 바꾸지 않는다.
// - 30분 지급 내역 동기화(syncPortonePayouts): 일괄 지급 ID가 적힌 포트원 묶음의 지급 내역을 읽어 F-07-6 applyPayoutFact로 반영한다(자동 재요청 없음).
// - 출금 대사(reconcilePortoneTransfers)·파트너 계좌 대조(checkPortonePartnerAccounts)·잔액 대사(reconcilePortoneBalance)·대사 멈춤(checkPortoneLedgerStale)·15시 실행 기록 없음(checkPortoneExecutionPending).
// 계좌번호 전체·예금주명은 이 파일 안 비교에만 쓰고 저장·로그·CS 건·경보에 넣지 않는다(건·경보에는 ID·금액·끝 4자리·사유 종류만).
import { uuidv7 } from '@peaket/platform';
import type { PayoutWrite, PortoneAccountTransfer, PortonePlatformTransport, StatementTransition } from '../domain/ports.js';
import { buildCaseDetail, type CaseDetailFlag } from '../domain/case-detail.js';
import { holderMatches } from '../domain/holder-name.js';
import { ledgerBalance } from '../domain/payout-adapters.js';
import { pgBalanceSeverity } from '../domain/pg-balance-reconciliation.js';
import {
  payoutEvent,
  SettlementProblem,
  type PayoutRecord,
  type PgBalanceReconciliationRecord,
  type PortoneLedgerSyncName,
  type PortoneLedgerSyncRecord,
  type PortonePartnerRecord,
  type SettlementAlertRequestRecord,
  type SettlementCaseRequestRecord,
  type StatementAuditRecord,
  type StatementRecord,
  type StatementStatus,
} from '../domain/settlement.js';
import type { SettlementDeps } from './settlements.js';

type HoldReason = NonNullable<StatementRecord['holdReason']>;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const KST_OFFSET_MS = 9 * HOUR_MS;
/** 출금 대사가 지난 성공 뒤 다시 읽는 겹침(30분 [가정]) */
const READ_OVERLAP_MS = 30 * MINUTE_MS;
/** 처음 대사(진행 행 없음)가 읽는 기간 [가정] */
const FIRST_READ_WINDOW_MS = 7 * DAY_MS;
/** 지급 완료 뒤 맞는 출금이 없으면 MISSING으로 보는 시간(1시간 [가정]) */
const MISSING_AFTER_MS = HOUR_MS;
/** 대사 멈춤 기준(계획 §5.1 (파) (다)): 출금 대사 3,600초·계좌 대조 90,000초 [가정] */
const STALE_AFTER_MS: Record<PortoneLedgerSyncName, number> = { WITHDRAWAL: 3_600_000, PARTNER_ACCOUNT: 90_000_000 };
/** 잔액 계산에 읽는 이체 원장 기간 [가정] */
const BALANCE_WINDOW_MS = 35 * DAY_MS;
const LIST_LIMIT = 500;

export const PORTONE_ALERT = {
  withdrawalUnmatched: 'settlement_portone_withdrawal_unmatched',
  partnerAccountMismatch: 'settlement_portone_partner_account_mismatch',
  ledgerSyncStale: 'settlement_portone_ledger_sync_stale',
  executionPending: 'settlement_portone_execution_pending',
} as const;

/** 그 시각의 KST 날짜('YYYY-MM-DD') */
export const kstDateOf = (at: Date | number): string => new Date((typeof at === 'number' ? at : at.getTime()) + KST_OFFSET_MS).toISOString().slice(0, 10);
/** 그 KST 날짜의 hh:00 KST 시각(ms) */
export const kstHourOf = (date: string, hour: number): number => Date.parse(`${date}T00:00:00.000Z`) - KST_OFFSET_MS + hour * HOUR_MS;

/**
 * 포트원 지급대행 계좌의 잔액을 이체 원장으로 계산한다(계획 I-15 (a) [가정 뜻]): 마지막 출금의 잔액 + 그 뒤 입금.
 * 출금이 없으면 잔액이 적힌 마지막 줄의 잔액, 원장이 비면 undefined. 조회가 실패하면 던진다.
 */
export async function portoneLedgerBalance(transport: PortonePlatformTransport, now: Date): Promise<number | undefined> {
  const rows = [...(await transport.listAccountTransfers({ from: new Date(now.getTime() - BALANCE_WINDOW_MS), to: now }))].sort((a, b) => a.transferredAt.getTime() - b.transferredAt.getTime());
  if (rows.length === 0) return undefined;
  let lastWithdrawal = -1;
  rows.forEach((r, i) => {
    if (r.type === 'WITHDRAWAL' && r.balance !== null) lastWithdrawal = i;
  });
  if (lastWithdrawal >= 0) {
    const base = rows[lastWithdrawal]!.balance ?? 0;
    return base + rows.slice(lastWithdrawal + 1).reduce((s, r) => s + (r.type === 'DEPOSIT' ? r.amount : 0), 0);
  }
  const withBalance = rows.filter((r) => r.balance !== null);
  return withBalance.length > 0 ? (withBalance.at(-1)!.balance ?? undefined) : undefined;
}

/**
 * 실행 건 detail(계획 §5.1 (파) (나)의 buildCaseDetail). 다 실을 수 있으면 앞머리를 `뺀 정산서: `로 쓴다
 * (고정된 J-T41 ②·J-T21 시험의 모양, 시험 이의로 보고). 잘라야 하면 buildCaseDetail 그대로(`뺀 정산서 {총수}건: … 외 M건`)다.
 */
export function executionDetail(input: Parameters<typeof buildCaseDetail>[0]): string {
  const out = buildCaseDetail(input);
  if (/ 외 \d+건\(전체는 SCR-049 묶음 상세\)$/u.test(out)) return out;
  return out.replace(/뺀 정산서 \d+건: /u, '뺀 정산서: ');
}

export interface PortonePayoutsHooks {
  /** F-07-6 Settlements.applyPayoutFact(지급 건 조건부 갱신과 정산서·묶음 쓰기) */
  applyPayoutFact(fact: { pgPayoutId: string; status: PayoutRecord['status']; errorCode?: string; observedAt: Date }): Promise<{ applied: boolean }>;
}

export class PortonePayouts {
  constructor(
    private readonly d: SettlementDeps,
    private readonly hooks: PortonePayoutsHooks,
  ) {}

  #now(): Date {
    return new Date(this.d.clock.now());
  }

  #audit(s: StatementRecord, to: StatementStatus, reason: string, at: Date): StatementAuditRecord {
    return { auditId: uuidv7(this.d.clock), statementId: s.statementId, fromStatus: s.status, toStatus: to, reason, actor: 'system', createdAt: at };
  }

  #case(kind: SettlementCaseRequestRecord['kind'], sourceId: string, eventKey: string, at: Date, detail?: string): SettlementCaseRequestRecord {
    return { eventKey, kind, sourceId, createdAt: at, requestedAt: null, ...(detail ? { detail } : {}) };
  }

  #alert(kind: string, severity: 'SEV2' | 'SEV3', sourceId: string, eventKey: string, at: Date): SettlementAlertRequestRecord {
    return { eventKey, kind, severity, sourceId, createdAt: at, requestedAt: null, refusedCount: 0, failedAt: null, lastRefusal: null };
  }

  /** HELD로 빼는 전이(출발 CONFIRMED·SCHEDULED, 감사와 PAYOUT_HELD 금액 = 지급액) */
  #holdTransition(s: StatementRecord, reason: HoldReason, now: Date): StatementTransition {
    const audit = this.#audit(s, 'HELD', `hold-${reason.toLowerCase()}`, now);
    const held: StatementRecord = { ...s, status: 'HELD', holdReason: reason, updatedAt: now };
    return { statementId: s.statementId, from: [s.status], to: 'HELD', set: { holdReason: reason }, updatedAt: now, audits: [audit], events: [payoutEvent(held, 'PAYOUT_HELD', s.payoutAmount, now, audit.auditId)] };
  }

  /**
   * SCHEDULED 포트원 정산서를 빼낸다: 수기 정산건을 취소한 뒤 살아 있는 REQUESTED 지급 건 CANCELED·T10 HELD·PAYOUT_HELD를 한 쓰기에(계획 I-07).
   * CONFIRMED면 결제사 호출 없이 HELD만. 취소가 실패하면 아무것도 쓰지 않고 false
   */
  async #pullOut(s: StatementRecord, reason: HoldReason, now: Date, extra: Pick<PayoutWrite, 'caseRequests' | 'alertRequests'> = {}): Promise<boolean> {
    const transport = this.d.portone;
    if (s.status === 'SCHEDULED') {
      if (!transport) return false;
      try {
        await transport.cancelManualTransfer(s.statementId);
      } catch (e) {
        this.d.log?.payoutJobFailed?.({ job: 'portone-transfer-cancel', reason: errorKind(e), at: now });
        return false;
      }
      const payouts = s.payoutBatchId ? (await this.d.store.listPayouts(s.payoutBatchId)).filter((p) => p.statementId === s.statementId && p.status === 'REQUESTED') : [];
      const out = await this.d.store.writePayoutChanges({
        payoutUpdates: payouts.map((p) => ({ payoutId: p.payoutId, from: ['REQUESTED'], set: { status: 'CANCELED', updatedAt: now } })),
        transitions: [this.#holdTransition(s, reason, now)],
        ...extra,
      });
      return out.ok;
    }
    if (s.status !== 'CONFIRMED') return false;
    const out = await this.d.store.writePayoutChanges({ transitions: [this.#holdTransition(s, reason, now)], ...extra });
    return out.ok;
  }

  // ---- I-07 실행 건(지급일 09:00 KST) ----

  async preparePortoneExecution(payoutDate: string): Promise<{ cases: number; held: number; halted: boolean }> {
    if (!this.d.portone) return { cases: 0, held: 0, halted: false };
    const now = this.#now();
    const withdrawal = await this.d.store.findLedgerSync('WITHDRAWAL');
    if (withdrawal?.haltedOn === payoutDate) return { cases: 0, held: 0, halted: true };
    const batches = await this.d.store.listPayoutBatches({ pg: 'PORTONE', payoutDate, status: ['SUBMITTED'], limit: LIST_LIMIT });
    const flags = await this.#commanderFlags(payoutDate, now);
    let cases = 0;
    let held = 0;
    for (const b of batches) {
      const eventKey = `portone-execution:${b.batchId}`;
      if (await this.d.store.findCaseRequest(eventKey)) continue;
      const bound = (await this.d.store.listStatementsByBatch(b.batchId)).filter((s) => s.status === 'SCHEDULED' || s.status === 'CONFIRMED');
      const excluded: { statementId: string; reason: string }[] = [];
      // 그 묶음 파트너의 계좌·정산 내역을 다시 대조한다(계획 I-14). 계좌가 다른 파트너의 정산서는 여기서 HELD ACCOUNT_MISMATCH가 된다
      const check = await this.checkPortonePartnerAccounts({ promoterIds: [...new Set(bound.map((s) => s.promoterId))], settlementDate: payoutDate });
      const boundIds = new Set(bound.map((s) => s.statementId));
      const excludedByCheck = new Set(check.excludedStatements.filter((id) => boundIds.has(id)));
      held += check.heldStatements.filter((id) => boundIds.has(id)).length;
      for (const id of excludedByCheck) {
        const s = await this.d.store.findStatementById(id);
        excluded.push({ statementId: id, reason: s?.status === 'HELD' && s.holdReason ? s.holdReason : 'AMOUNT_MISMATCH' });
      }
      const rest = bound.filter((s) => !excludedByCheck.has(s.statementId));
      const nine = kstHourOf(payoutDate, 9);
      const suspended = await this.d.saleSuspensions.listSuspended(rest.map((s) => s.eventId).filter((id): id is string => id !== null));
      for (const s0 of rest) {
        const s = (await this.d.store.findStatementById(s0.statementId)) ?? s0;
        const account = await this.d.store.findPayoutAccount(s.promoterId);
        let reason: HoldReason | undefined;
        if (s.eventId !== null && suspended.has(s.eventId)) reason = 'SALE_SUSPENDED';
        else if (account && (account.holdUntil.getTime() > nine || account.agencySyncPending === true)) reason = 'ACCOUNT_CHANGE';
        if (!reason) continue;
        if (await this.#pullOut(s, reason, now)) {
          held += 1;
          excluded.push({ statementId: s.statementId, reason });
        }
      }
      const detail = executionDetail({ excluded, flags });
      const inserted = await this.d.store.insertCaseRequests([this.#case('PORTONE_PAYOUT_EXECUTION', b.batchId, eventKey, now, detail || undefined)]);
      cases += inserted;
    }
    return { cases, held, halted: false };
  }

  /** 멈춤 동안이거나 그날 08:00 계좌 대조가 성공하지 못했으면 'commander 확인 필요'(계획 §5.1 (파) (다)). 진행 행이 없으면(처음) 멈춤으로 보지 않는다 */
  async #commanderFlags(payoutDate: string, now: Date): Promise<CaseDetailFlag[]> {
    const withdrawal = await this.d.store.findLedgerSync('WITHDRAWAL');
    const partner = await this.d.store.findLedgerSync('PARTNER_ACCOUNT');
    const withdrawalStale = withdrawal?.lastSuccessAt ? now.getTime() - withdrawal.lastSuccessAt.getTime() >= STALE_AFTER_MS.WITHDRAWAL : false;
    const partnerMissed = partner?.lastSuccessAt ? partner.lastSuccessAt.getTime() < kstHourOf(payoutDate, 8) : false;
    return withdrawalStale || partnerMissed ? ['commander 확인 필요'] : [];
  }

  // ---- I-07 30분 지급 내역 동기화 ----

  async syncPortonePayouts(limit = LIST_LIMIT): Promise<{ applied: number }> {
    const transport = this.d.portone;
    if (!transport) return { applied: 0 };
    const now = this.#now();
    let applied = 0;
    const batches = await this.d.store.listPayoutBatches({ pg: 'PORTONE', status: ['SUBMITTED', 'PARTIAL_FAILED'], limit });
    for (const b of batches) {
      if (!b.portoneBulkPayoutId) continue;
      let items;
      try {
        items = await transport.listPayouts({ bulkPayoutId: b.portoneBulkPayoutId });
      } catch (e) {
        this.d.log?.payoutJobFailed?.({ job: 'portone-payout-sync', batchId: b.batchId, reason: errorKind(e), at: now });
        continue;
      }
      for (const item of items) {
        if (item.status === 'PENDING') continue;
        const status: PayoutRecord['status'] = item.status === 'SUCCEEDED' ? 'COMPLETED' : 'FAILED';
        // 포트원 실패 갈래는 코드 표가 없어 모름(UNKNOWN)으로 둔다: 자동 재요청 없이 CS PAYOUT_FAILED(계획 I-07)
        const r = await this.hooks.applyPayoutFact({ pgPayoutId: item.transferId, status, ...(status === 'FAILED' ? { errorCode: `PORTONE_${item.status}` } : {}), observedAt: item.completedAt ?? now });
        if (r.applied) applied += 1;
      }
    }
    return { applied };
  }

  // ---- I-13 출금 대사(30분) ----

  async reconcilePortoneTransfers(): Promise<{ checked: number; mismatched: number; unlinked: number; missing: number }> {
    const transport = this.d.portone;
    const out = { checked: 0, mismatched: 0, unlinked: 0, missing: 0 };
    if (!transport) return out;
    const now = this.#now();
    const sync = await this.d.store.findLedgerSync('WITHDRAWAL');
    const from = sync?.readThrough ?? new Date(now.getTime() - FIRST_READ_WINDOW_MS);
    let transfers: readonly PortoneAccountTransfer[];
    const candidates = await this.d.store.listPortonePayoutsForTransferCheck(LIST_LIMIT);
    // 포트원 지급 ID → 수기 정산건 ID(= 지급 건의 결제사 지급 ID). 대상 지급 건의 묶음 지급 내역으로 잇는다
    const portonePayoutToTransfer = new Map<string, string>();
    try {
      transfers = (await transport.listAccountTransfers({ from, to: now })).filter((t) => t.type === 'WITHDRAWAL');
      const bulkIds = new Set<string>();
      for (const batchId of new Set(candidates.map((p) => p.batchId))) {
        const b = await this.d.store.findPayoutBatch(batchId);
        if (b?.portoneBulkPayoutId) bulkIds.add(b.portoneBulkPayoutId);
      }
      for (const bulkPayoutId of bulkIds) for (const item of await transport.listPayouts({ bulkPayoutId })) portonePayoutToTransfer.set(item.payoutId, item.transferId);
    } catch (e) {
      // 끝까지 읽지 못했다: 아무것도 쓰지 않고 성공 시각·읽은 시각을 옮기지 않는다(J-T22 ③)
      this.d.log?.portoneReconciliationFailed?.({ name: 'WITHDRAWAL', kind: errorKind(e), at: now });
      throw new SettlementProblem('payout-gateway-unavailable', 503, '포트원 이체 원장을 읽지 못했습니다');
    }
    const byPgPayoutId = new Map(candidates.filter((p) => p.pgPayoutId !== null).map((p) => [p.pgPayoutId!, p]));
    const matchedPayouts = new Set<string>();
    let haltedOn = sync?.haltedOn ?? null;
    for (const t of [...transfers].sort((a, b) => a.transferredAt.getTime() - b.transferredAt.getTime())) {
      const manualId = t.payoutId ? portonePayoutToTransfer.get(t.payoutId) : undefined;
      const p = manualId ? byPgPayoutId.get(manualId) : undefined;
      if (p && !matchedPayouts.has(p.payoutId)) {
        matchedPayouts.add(p.payoutId);
        const s = await this.d.store.findStatementById(p.statementId);
        const account = s ? await this.d.store.findPayoutAccount(s.promoterId) : undefined;
        const kyc = s ? await this.d.store.findKyc(s.promoterId) : undefined;
        const holderOk = t.holderName === null ? null : kyc?.legalName ? holderMatches(t.holderName, { legalName: kyc.legalName, representative: kyc.representative ?? '' }) : false;
        const accountOk = account !== undefined && t.bankCode === account.bankCode && t.accountLast4 === account.accountLast4;
        const ok = t.amount === p.amount && accountOk && holderOk !== false;
        const write: PayoutWrite = {
          portoneTransfer: { transferId: t.transferId, withdrawalType: t.withdrawalType, payoutId: p.payoutId, amount: t.amount, bankCode: t.bankCode, accountLast4: t.accountLast4, holderMatched: holderOk, checkResult: ok ? 'MATCHED' : 'MISMATCH', transferredAt: t.transferredAt, checkedAt: now },
          payoutUpdates: [{ payoutId: p.payoutId, set: { pgTransferId: t.transferId, transferCheck: ok ? 'MATCHED' : 'MISMATCH', transferCheckedAt: now, updatedAt: now } }],
          ...(ok
            ? {}
            : {
                caseRequests: [this.#case('PORTONE_LEDGER_MISMATCH', t.transferId, `portone-transfer:${t.transferId}`, now)],
                alertRequests: [this.#alert(PORTONE_ALERT.withdrawalUnmatched, 'SEV2', t.transferId, `portone-transfer-alert:${t.transferId}`, now)],
              }),
        };
        if (!(await this.d.store.writePayoutChanges(write)).ok) continue;
        out.checked += 1;
        if (!ok) {
          out.mismatched += 1;
          this.d.signals?.portoneWithdrawalUnmatched?.();
        }
        continue;
      }
      // 지급 건과 이어지지 않는 출금: 이체 쪽 UNLINKED, 그날(KST) 남은 포트원 실행을 멈춘다(ADR-0370 결정 8 ①)
      const today = kstDateOf(now);
      const halts = await this.#haltCases(today, t.transferId, now);
      const write: PayoutWrite = {
        portoneTransfer: { transferId: t.transferId, withdrawalType: t.withdrawalType, payoutId: null, amount: t.amount, bankCode: t.bankCode, accountLast4: t.accountLast4, holderMatched: null, checkResult: 'UNLINKED', transferredAt: t.transferredAt, checkedAt: now },
        caseRequests: [this.#case('PORTONE_LEDGER_MISMATCH', t.transferId, `portone-transfer:${t.transferId}`, now), ...halts],
        alertRequests: [this.#alert(PORTONE_ALERT.withdrawalUnmatched, 'SEV2', t.transferId, `portone-transfer-alert:${t.transferId}`, now)],
        ledgerSync: { name: 'WITHDRAWAL', lastSuccessAt: sync?.lastSuccessAt ?? null, readThrough: sync?.readThrough ?? null, haltedOn: today, updatedAt: now },
      };
      if (!(await this.d.store.writePayoutChanges(write)).ok) continue;
      haltedOn = today;
      out.checked += 1;
      out.unlinked += 1;
      this.d.signals?.portoneWithdrawalUnmatched?.();
    }
    // 완료 뒤 1시간이 지났는데 맞는 출금이 없는 지급 건(MISSING)
    for (const p of candidates) {
      if (p.status !== 'COMPLETED' || matchedPayouts.has(p.payoutId) || p.transferCheck !== null) continue;
      if (now.getTime() - p.updatedAt.getTime() < MISSING_AFTER_MS) continue;
      const write: PayoutWrite = {
        payoutUpdates: [{ payoutId: p.payoutId, from: ['COMPLETED'], set: { transferCheck: 'MISSING', transferCheckedAt: now, updatedAt: now } }],
        caseRequests: [this.#case('PORTONE_LEDGER_MISMATCH', p.payoutId, `portone-missing:${p.payoutId}`, now)],
        alertRequests: [this.#alert(PORTONE_ALERT.withdrawalUnmatched, 'SEV2', p.payoutId, `portone-missing-alert:${p.payoutId}`, now)],
      };
      if (!(await this.d.store.writePayoutChanges(write)).ok) continue;
      out.missing += 1;
      this.d.signals?.portoneWithdrawalUnmatched?.();
    }
    await this.d.store.saveLedgerSync({ name: 'WITHDRAWAL', lastSuccessAt: now, readThrough: new Date(now.getTime() - READ_OVERLAP_MS), haltedOn, updatedAt: now });
    return out;
  }

  /** 그날 이미 연 실행 건이 있는 포트원 묶음마다 '실행 멈춤' 건(새 사건 키 portone-execution-halt:{묶음}:{날짜}, 계획 I-13) */
  async #haltCases(date: string, transferId: string, now: Date): Promise<SettlementCaseRequestRecord[]> {
    const out: SettlementCaseRequestRecord[] = [];
    for (const b of await this.d.store.listPayoutBatches({ pg: 'PORTONE', payoutDate: date, status: ['SUBMITTED'], limit: LIST_LIMIT })) {
      if (!(await this.d.store.findCaseRequest(`portone-execution:${b.batchId}`))) continue;
      out.push(this.#case('PORTONE_PAYOUT_EXECUTION', b.batchId, `portone-execution-halt:${b.batchId}:${date}`, now, buildCaseDetail({ excluded: [], flags: ['실행 멈춤'], transferIds: [transferId] })));
    }
    return out;
  }

  // ---- I-14 파트너 계좌 대조(08:00 KST·09:00 실행 건) ----

  /**
   * 포트원 파트너의 정산 계좌(예약된 변경 포함)를 PEAKET 기록과 맞춘다. 다른 파트너의 포트원 결제분 CONFIRMED·SCHEDULED 정산서를 HELD ACCOUNT_MISMATCH로 빼고
   * CS(대상 = 파트너)·SEV2를 남긴다. settlementDate가 있으면 그 정산일 정산 내역 금액도 맞추고 다른 정산서는 그날 실행에서만 뺀다(상태 그대로).
   * 파트너를 고르지 않은 전체 대조가 끝까지 성공하면 PARTNER_ACCOUNT 성공 시각을 옮긴다
   */
  async checkPortonePartnerAccounts(input: { promoterIds?: readonly string[]; settlementDate?: string } = {}): Promise<{ checked: number; mismatched: number; excludedStatements: readonly string[]; heldStatements: readonly string[] }> {
    const transport = this.d.portone;
    const result = { checked: 0, mismatched: 0, excludedStatements: [] as string[], heldStatements: [] as string[] };
    if (!transport) return result;
    const now = this.#now();
    const today = kstDateOf(now);
    const partners: PortonePartnerRecord[] = [];
    if (input.promoterIds) {
      for (const id of input.promoterIds) {
        const p = await this.d.store.findPortonePartner(id);
        if (p) partners.push(p);
      }
    } else partners.push(...(await this.d.store.listPortonePartners(LIST_LIMIT)));
    let failed = false;
    const matchedPromoters = new Set<string>();
    for (const partner of partners) {
      let remote;
      try {
        remote = await transport.getPartner(partner.portonePartnerId);
      } catch (e) {
        failed = true;
        this.d.log?.portoneReconciliationFailed?.({ name: 'PARTNER_ACCOUNT', kind: errorKind(e), at: now });
        continue;
      }
      result.checked += 1;
      const account = await this.d.store.findPayoutAccount(partner.promoterId);
      const kyc = await this.d.store.findKyc(partner.promoterId);
      const same = (a: { bankCode: string; accountLast4: string; holderName: string }) =>
        account !== undefined && a.bankCode === account.bankCode && a.accountLast4 === account.accountLast4 && Boolean(kyc?.legalName) && holderMatches(a.holderName, { legalName: kyc?.legalName ?? '', representative: kyc?.representative ?? '' });
      const matched = same(remote) && (remote.scheduled === null || same(remote.scheduled));
      await this.d.store.savePortonePartner({ ...partner, lastAccountCheck: matched ? 'MATCHED' : 'MISMATCH', lastAccountCheckedAt: now, updatedAt: now });
      if (matched) {
        matchedPromoters.add(partner.promoterId);
        continue;
      }
      result.mismatched += 1;
      const statements = await this.d.store.listStatementsOfPromoter(partner.promoterId, 'PORTONE', ['CONFIRMED', 'SCHEDULED']);
      const caseRequests = [this.#case('PORTONE_LEDGER_MISMATCH', partner.promoterId, `portone-account:${partner.promoterId}:${today}`, now)];
      const alertRequests = [this.#alert(PORTONE_ALERT.partnerAccountMismatch, 'SEV2', partner.promoterId, `portone-account-alert:${partner.promoterId}:${today}`, now)];
      let attached = false;
      for (const s of statements) {
        const ok = await this.#pullOut(s, 'ACCOUNT_MISMATCH', now, attached ? {} : { caseRequests, alertRequests });
        if (ok) {
          attached = true;
          result.heldStatements.push(s.statementId);
          result.excludedStatements.push(s.statementId);
        } else if (s.status === 'SCHEDULED' && s.payoutDate === input.settlementDate) {
          // 수기 정산건을 취소하지 못했다: 그날 실행에서만 뺀다(사람이 본다)
          result.excludedStatements.push(s.statementId);
        }
      }
      if (!attached) {
        await this.d.store.insertCaseRequests(caseRequests);
        await this.d.store.insertAlertRequests(alertRequests);
      }
    }
    if (input.settlementDate && matchedPromoters.size > 0) {
      let items: readonly { partnerId: string; transferId: string; amount: number }[] | undefined;
      try {
        items = await transport.listPartnerSettlements(input.settlementDate);
      } catch (e) {
        failed = true;
        this.d.log?.portoneReconciliationFailed?.({ name: 'PARTNER_ACCOUNT', kind: errorKind(e), at: now });
      }
      if (items) {
        const byTransfer = new Map(items.map((i) => [i.transferId, i]));
        for (const promoterId of matchedPromoters) {
          const partner = partners.find((p) => p.promoterId === promoterId)!;
          for (const s of await this.d.store.listStatementsOfPromoter(promoterId, 'PORTONE', ['SCHEDULED'])) {
            if (s.payoutDate !== input.settlementDate) continue;
            const item = byTransfer.get(s.statementId);
            if (item && item.amount === s.payoutAmount && item.partnerId === partner.portonePartnerId) continue;
            // 정산 내역 금액이 다르다: 그 정산서만 그날 실행에서 뺀다(상태는 SCHEDULED 그대로, 다음 영업일 실행 건이 다시 본다 [가정])
            result.excludedStatements.push(s.statementId);
            await this.d.store.writePayoutChanges({
              caseRequests: [this.#case('PORTONE_LEDGER_MISMATCH', s.statementId, `portone-settlement:${s.statementId}:${input.settlementDate}`, now)],
              alertRequests: [this.#alert(PORTONE_ALERT.partnerAccountMismatch, 'SEV2', s.statementId, `portone-settlement-alert:${s.statementId}:${input.settlementDate}`, now)],
            });
          }
        }
      }
    }
    const all = await this.d.store.listPortonePartners(LIST_LIMIT);
    this.d.signals?.portonePartnerAccountMismatch?.(all.filter((p) => p.lastAccountCheck === 'MISMATCH').length);
    if (!input.promoterIds && !failed) {
      const prev = await this.d.store.findLedgerSync('PARTNER_ACCOUNT');
      await this.d.store.saveLedgerSync({ name: 'PARTNER_ACCOUNT', lastSuccessAt: now, readThrough: prev?.readThrough ?? null, haltedOn: prev?.haltedOn ?? null, updatedAt: now });
    }
    return result;
  }

  /** 08:00 KST 뒤 그날 첫 tick의 전체 계좌 대조(하루 한 번: 그날 08:00 뒤 성공이 있으면 건너뜀). 부르지 않았으면 undefined */
  async runDailyPartnerCheck(): Promise<{ checked: number; mismatched: number } | undefined> {
    if (!this.d.portone) return undefined;
    const now = this.#now();
    const eight = kstHourOf(kstDateOf(now), 8);
    if (now.getTime() < eight) return undefined;
    const sync = await this.d.store.findLedgerSync('PARTNER_ACCOUNT');
    if (sync?.lastSuccessAt && sync.lastSuccessAt.getTime() >= eight) return undefined;
    const r = await this.checkPortonePartnerAccounts();
    return { checked: r.checked, mismatched: r.mismatched };
  }

  // ---- I-15 잔액 대사·대사 멈춤·15시 실행 기록 없음 ----

  /** 포트원 결제분(상점 STANDARD)의 월말·묶음 잔액 대사. 보이는 잔액 = 이체 원장 계산값. 결제사 수수료는 0 [가정](정리 목록). 같은 달·같은 묶음이면 undefined */
  async reconcilePortoneBalance(input: { kind: 'MONTHLY'; periodMonth: string } | { kind: 'BATCH'; batchId: string }): Promise<PgBalanceReconciliationRecord | undefined> {
    const transport = this.d.portone;
    const ledgerSource = this.d.pgLedger;
    if (!transport || !ledgerSource) throw new SettlementProblem('payout-gateway-unavailable', 503, '지급대행을 아직 시작할 수 없습니다');
    const now = this.#now();
    const ledger = await ledgerSource.ledger({ pg: 'PORTONE', pgStore: 'STANDARD', cutoffAt: now });
    let observed: number | undefined;
    try {
      observed = await portoneLedgerBalance(transport, now);
    } catch (e) {
      this.d.log?.portoneReconciliationFailed?.({ name: 'BALANCE', kind: errorKind(e), at: now });
      throw new SettlementProblem('pg-balance-unavailable', 503, '결제사 잔액을 확인할 수 없습니다');
    }
    const pgFeeAmount = 0;
    const expectedAmount = ledgerBalance({ approvedAmount: ledger.approvedAmount, refundedAmount: ledger.refundedAmount, pgFees: pgFeeAmount, paidOut: ledger.paidOutAmount, peaketWithdrawn: 0 });
    const observedAmount = observed ?? 0;
    const diffAmount = observedAmount - expectedAmount;
    const record: PgBalanceReconciliationRecord = {
      reconciliationId: uuidv7(this.d.clock),
      pg: 'PORTONE',
      pgStore: 'STANDARD',
      kind: input.kind,
      periodMonth: input.kind === 'MONTHLY' ? input.periodMonth : null,
      batchId: input.kind === 'BATCH' ? input.batchId : null,
      cutoffAt: now,
      approvedAmount: ledger.approvedAmount,
      refundedAmount: ledger.refundedAmount,
      pgFeeAmount,
      paidOutAmount: ledger.paidOutAmount,
      peaketWithdrawnAmount: 0,
      expectedAmount,
      observedAmount,
      diffAmount,
      severity: pgBalanceSeverity(diffAmount),
      createdAt: now,
    };
    const caseRequest = diffAmount !== 0 ? this.#case('PG_BALANCE_MISMATCH', 'PORTONE:STANDARD', record.reconciliationId, now) : undefined;
    if (!(await this.d.store.insertPgBalanceReconciliation(record, caseRequest))) return undefined;
    this.d.signals?.pgBalanceDiff('PORTONE', 'STANDARD', diffAmount);
    return record;
  }

  /** 두 대사의 마지막 성공 뒤 지난 시간(지표)과 기준을 넘은 멈춤의 SEV2 한 번(같은 멈춤 동안 한 번, 사건 키 portone-sync-stale:{이름}:{마지막 성공}) */
  async checkPortoneLedgerStale(): Promise<{ stale: readonly PortoneLedgerSyncName[] }> {
    if (!this.d.portone) return { stale: [] };
    const now = this.#now();
    const stale: PortoneLedgerSyncName[] = [];
    for (const name of ['WITHDRAWAL', 'PARTNER_ACCOUNT'] as const) {
      const rec: PortoneLedgerSyncRecord | undefined = await this.d.store.findLedgerSync(name);
      if (!rec?.lastSuccessAt) continue;
      const age = now.getTime() - rec.lastSuccessAt.getTime();
      this.d.signals?.portoneLedgerSyncAge?.(name, Math.floor(age / 1000));
      if (age < STALE_AFTER_MS[name]) continue;
      stale.push(name);
      await this.d.store.insertAlertRequests([this.#alert(PORTONE_ALERT.ledgerSyncStale, 'SEV2', name, `portone-sync-stale:${name}:${rec.lastSuccessAt.toISOString()}`, now)]);
    }
    return { stale };
  }

  /** 지급일 15:00 KST 뒤: 일괄 지급 ID가 없는 그날 SUBMITTED 포트원 묶음 수(게이지)와 1 이상이면 operator SEV3 한 번 */
  async checkPortoneExecutionPending(payoutDate: string): Promise<{ pending: number }> {
    const now = this.#now();
    const batches = await this.d.store.listPayoutBatches({ pg: 'PORTONE', payoutDate, status: ['SUBMITTED'], limit: LIST_LIMIT });
    const pending = batches.filter((b) => !b.portoneBulkPayoutId).length;
    this.d.signals?.portoneExecutionPending?.(pending);
    if (pending > 0) await this.d.store.insertAlertRequests([this.#alert(PORTONE_ALERT.executionPending, 'SEV3', payoutDate, `portone-execution-pending:${payoutDate}`, now)]);
    return { pending };
  }
}

/** 로그에 남길 까닭 종류(오류 글에는 계좌번호가 있을 수 있어 이름·종류만) */
function errorKind(e: unknown): string {
  if (e && typeof e === 'object' && 'kind' in e && typeof (e as { kind: unknown }).kind === 'string') return (e as { kind: string }).kind;
  if (e instanceof SettlementProblem) return e.type;
  return e instanceof Error ? e.name : 'unknown';
}
