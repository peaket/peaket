// 양도 알림 행과 보내기 반복(docs/features/notify.md §4.8, docs/data.md `transfer_notice`, 계획 docs/review/plans/F-05-11.md §4).
// - 사건마다 두 사람 행(약한 재인증은 보낸 사람 하나). 중복 키는 (type, offerId, accountId)다.
// - 2xx·422는 보낸 것으로 적고, 5xx·연결 실패는 1·5·30분 [가정] 뒤 다시 보낸다. 보낸 행은 7일 [가정] 뒤 지운다.
// - 알림을 못 보내도 양도 응답은 바뀌지 않는다(행은 업무와 같은 트랜잭션에 이미 커밋됐다).
import { randomUUID } from 'node:crypto';
import type { PublicWithdrawReason } from './transfer.js';
import type { StoredTransferNotice, TransferNoticeStore } from './transfer-ports.js';

/** 보내기 반복이 쓰는 시계(도메인은 플랫폼을 가져오지 않는다, architecture §3.1). 평소에는 platform Clock이 그대로 맞는다 */
export interface TransferNoticeClock {
  now(): number;
}

export type TransferNoticeType = 'TRANSFER_OFFERED' | 'TRANSFER_ACCEPTED' | 'TRANSFER_REJECTED' | 'TRANSFER_WITHDRAWN' | 'TRANSFER_EXPIRED' | 'TICKET_RETURNED' | 'TRANSFER_WEAK_REAUTH';
export type TransferNoticeParty = 'SENDER' | 'RECIPIENT' | 'PAYER' | 'RETURNER';

export interface TransferNoticeRecord {
  readonly noticeId: string;
  readonly type: TransferNoticeType;
  readonly party: TransferNoticeParty;
  readonly offerId: string;
  readonly ticketId: string;
  readonly eventId: string;
  readonly accountId: string;
  readonly reason?: PublicWithdrawReason;
  readonly createdAtMs: number;
}

/** 다시 보낼 간격(1분·5분·30분 [가정], 그 뒤는 30분마다). attempts는 이번까지 보낸 횟수다 */
export const TRANSFER_NOTICE_RETRY_MS = [60_000, 300_000, 1_800_000] as const;
export const transferNoticeRetryDelayMs = (attempts: number): number =>
  TRANSFER_NOTICE_RETRY_MS[Math.max(0, Math.min(TRANSFER_NOTICE_RETRY_MS.length - 1, attempts - 1))]!;
export const TRANSFER_NOTICE_LEASE_MS = 60_000;
export const TRANSFER_NOTICE_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const TRANSFER_NOTICE_EVERY_MS = 5_000;

export interface TransferNoticeEvent {
  readonly noticeId: string;
  readonly type: TransferNoticeType;
  readonly party: TransferNoticeParty;
  readonly offerId: string;
  readonly ticketId: string;
  readonly eventId: string;
  readonly accountId: string;
  readonly reason?: PublicWithdrawReason;
  readonly createdAtMs: number;
}

export type TransferNoticeSendResult = { kind: 'sent' } | { kind: 'retry'; reason: string };

export interface TransferNoticeSink {
  send(n: TransferNoticeEvent): Promise<TransferNoticeSendResult>;
}

/**
 * 한 사건의 알림 행들. `fromAccountId`는 보낸 사람(돌려주기면 돌려준 사람), `toAccountId`는 받는 사람(돌려주기면 결제자)이다.
 * `TICKET_RETURNED`는 PAYER=toAccountId, RETURNER=fromAccountId, 철회 사유는 공개 값(OTHER로 가린 값 포함)만 싣는다.
 */
export function noticesOf(e: {
  readonly type: TransferNoticeType;
  readonly offerId: string;
  readonly ticketId: string;
  readonly eventId: string;
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly reason?: PublicWithdrawReason;
  readonly weakReauth?: boolean;
  readonly nowMs: number;
  readonly noticeIdOf?: () => string;
}): readonly TransferNoticeRecord[] {
  const id = e.noticeIdOf ?? (() => randomUUID());
  const row = (type: TransferNoticeType, party: TransferNoticeParty, accountId: string, reason?: PublicWithdrawReason): TransferNoticeRecord => ({
    noticeId: id(),
    type,
    party,
    offerId: e.offerId,
    ticketId: e.ticketId,
    eventId: e.eventId,
    accountId,
    createdAtMs: e.nowMs,
    ...(reason === undefined ? {} : { reason }),
  });
  const out: TransferNoticeRecord[] = [];
  switch (e.type) {
    case 'TICKET_RETURNED':
      out.push(row('TICKET_RETURNED', 'PAYER', e.toAccountId), row('TICKET_RETURNED', 'RETURNER', e.fromAccountId));
      break;
    case 'TRANSFER_WEAK_REAUTH':
      out.push(row('TRANSFER_WEAK_REAUTH', 'SENDER', e.fromAccountId));
      break;
    case 'TRANSFER_WITHDRAWN':
      out.push(row('TRANSFER_WITHDRAWN', 'SENDER', e.fromAccountId, e.reason), row('TRANSFER_WITHDRAWN', 'RECIPIENT', e.toAccountId, e.reason));
      if (e.weakReauth) out.push(row('TRANSFER_WEAK_REAUTH', 'SENDER', e.fromAccountId));
      break;
    default:
      out.push(row(e.type, 'SENDER', e.fromAccountId), row(e.type, 'RECIPIENT', e.toAccountId));
      if (e.weakReauth) out.push(row('TRANSFER_WEAK_REAUTH', 'SENDER', e.fromAccountId));
      break;
  }
  return out;
}

export interface TransferNoticeRunResult {
  readonly attempted: number;
  readonly sent: number;
  readonly retried: number;
  readonly purged: number;
}

export interface TransferNoticeSenderDeps {
  readonly store: TransferNoticeStore;
  readonly sink: TransferNoticeSink;
  readonly clock: TransferNoticeClock;
  /** 한 바퀴에 잡는 행 수(기본 50 [가정]) */
  readonly batch?: number;
  readonly observe?: (o: { readonly type: TransferNoticeType; readonly result: 'sent' | 'retry' }) => void;
}

export function transferNoticeEventOf(n: StoredTransferNotice): TransferNoticeEvent {
  return {
    noticeId: n.noticeId,
    type: n.type,
    party: n.party,
    offerId: n.offerId,
    ticketId: n.ticketId,
    eventId: n.eventId,
    accountId: n.accountId,
    createdAtMs: n.createdAtMs,
    ...(n.reason === undefined ? {} : { reason: n.reason }),
  };
}

export class TransferNoticeSender {
  constructor(private readonly d: TransferNoticeSenderDeps) {}

  async runOnce(): Promise<TransferNoticeRunResult> {
    const now = this.d.clock.now();
    const due = await this.d.store.claimDue(now, this.d.batch ?? 50, TRANSFER_NOTICE_LEASE_MS);
    let sent = 0;
    let retried = 0;
    for (const n of due) {
      let r: TransferNoticeSendResult;
      try {
        r = await this.d.sink.send(transferNoticeEventOf(n));
      } catch (e) {
        r = { kind: 'retry', reason: e instanceof Error ? e.name : 'unknown' };
      }
      if (r.kind === 'sent') {
        await this.d.store.markSent(n.noticeId, this.d.clock.now());
        sent += 1;
        this.d.observe?.({ type: n.type, result: 'sent' });
      } else {
        await this.d.store.reschedule(n.noticeId, now + transferNoticeRetryDelayMs(n.attempts));
        retried += 1;
        this.d.observe?.({ type: n.type, result: 'retry' });
      }
    }
    const purged = await this.d.store.purgeSent(now - TRANSFER_NOTICE_RETENTION_MS);
    return { attempted: due.length, sent, retried, purged };
  }

  async backlog(): Promise<{ count: number; oldestSeconds: number }> {
    const b = await this.d.store.backlog();
    const oldestSeconds = b.oldestCreatedAtMs === undefined ? 0 : Math.max(0, (this.d.clock.now() - b.oldestCreatedAtMs) / 1000);
    return { count: b.count, oldestSeconds };
  }
}
