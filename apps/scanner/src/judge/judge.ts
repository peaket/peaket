// 스캐너 앱 판정 10단계(offline-gate §6.4 '스캐너 앱 판정 첫 구현', 계획 docs/review/plans/F-05-4.md §3).
// 순수 함수다. 판정 중 예외는 통과가 아니라 다시 찍기(RETRY)다(fail-closed).
import type { EntryState, PackageState } from '../storage/package-state.ts';
import { isReadablePublicKey, parseQrV1, verifyQrSignature, type ScannedQr } from './qr-v1.ts';

export type RejectReason =
  | 'INVALID_QR'
  | 'UNSUPPORTED_VERSION'
  | 'UNKNOWN_TICKET'
  | 'TICKET_CANCELLED'
  | 'KEY_REVOKED'
  | 'KEY_UNKNOWN'
  | 'BAD_SIGNATURE'
  | 'QR_EXPIRED'
  | 'WRONG_ZONE'
  | 'ALREADY_IN';
export type CheckReason = 'NO_EXIT_RECORD' | 'NO_ENTRY_RECORD';
export type JudgeOutcome =
  | { result: 'PASS'; direction: 'IN' | 'OUT'; ticketId: string; keyId: string; qrTimestampMs: number; seatLabel: string }
  | { result: 'REJECT'; reason: RejectReason; direction: 'IN' | 'OUT'; ticketId?: string; keyId?: string; qrTimestampMs?: number; ticketGateZone?: string; lastEntry?: EntryState }
  | { result: 'CHECK'; reason: CheckReason; direction: 'IN' | 'OUT'; ticketId: string; keyId: string; qrTimestampMs: number; seatLabel: string; lastEntry?: EntryState }
  | { result: 'RETRY' };

/** 앱 판정 7단계의 허용 오차(±30초, offline-gate §3·§6.4) */
const QR_TOLERANCE_MS = 30_000;
/** 거부로 닫는 티켓 상태(§6.4 3) */
const CANCELLED_STATUSES = new Set(['CANCEL_REQUESTED', 'REFUNDED', 'VOIDED']);
/** 통과로 여는 티켓 상태. 목록이 모르는 값은 다시 찍기다(§6.4 3) */
const OPEN_STATUSES = new Set(['ISSUED', 'ACTIVE', 'TRANSFER_PENDING', 'FLAGGED']);

const directionOf = (state: PackageState): 'IN' | 'OUT' => state.placement.mode;

/** 한국 시각(Asia/Seoul) HH:MM. 판정 문구의 시각은 이 표기를 쓴다(d5 §8.3 예 '19:02') */
function kstHourMinute(ms: number): string {
  const kst = new Date(ms + 9 * 3_600_000);
  const h = String(kst.getUTCHours()).padStart(2, '0');
  const m = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

export async function judgeScan(i: {
  raw: string;
  state: PackageState;
  /** 기기 시각 */
  nowMs: number;
  /** 근무 준비가 잰 서버 오차. 보정 시각 = 기기 시각 + 오차 */
  clockOffsetMs: number;
  verify?: typeof verifyQrSignature;
}): Promise<JudgeOutcome> {
  const direction = directionOf(i.state);
  // 1. 풀기·형식 버전
  const parsed = parseQrV1(i.raw);
  if (!parsed.ok) return { result: 'REJECT', reason: parsed.reason, direction };
  const qr: ScannedQr = parsed.qr;
  // 2. 목록에 없는 티켓
  const ticket = i.state.tickets.get(qr.ticketId);
  if (!ticket) return { result: 'REJECT', reason: 'UNKNOWN_TICKET', direction, ticketId: qr.ticketId, keyId: qr.keyId };
  // 3. 취소·환급·무효
  if (CANCELLED_STATUSES.has(ticket.status)) return { result: 'REJECT', reason: 'TICKET_CANCELLED', direction, ticketId: qr.ticketId, keyId: qr.keyId };
  if (!OPEN_STATUSES.has(ticket.status)) return { result: 'RETRY' };
  // 4. 폐기된 키
  if (i.state.revoked.has(qr.keyId)) return { result: 'REJECT', reason: 'KEY_REVOKED', direction, ticketId: qr.ticketId, keyId: qr.keyId };
  // 5. 유효 키가 아님(공개키가 없거나 읽히지 않아도 모르는 키다)
  const key = ticket.keys.find((k) => k.keyId === qr.keyId);
  if (!key || !key.publicKey || !isReadablePublicKey(key.publicKey)) return { result: 'REJECT', reason: 'KEY_UNKNOWN', direction, ticketId: qr.ticketId, keyId: qr.keyId };
  // 6. 서명 검증. 검증기가 던지면 다시 찍기
  let ok: boolean;
  try {
    ok = await (i.verify ?? verifyQrSignature)(key.publicKey, qr);
  } catch {
    return { result: 'RETRY' };
  }
  if (!ok) return { result: 'REJECT', reason: 'BAD_SIGNATURE', direction, ticketId: qr.ticketId, keyId: qr.keyId };
  const qrTimestampMs = qr.timestampSec * 1000;
  // 7. 시각 ±30초
  const correctedMs = i.nowMs + i.clockOffsetMs;
  if (Math.abs(qrTimestampMs - correctedMs) > QR_TOLERANCE_MS) return { result: 'REJECT', reason: 'QR_EXPIRED', direction, ticketId: qr.ticketId, keyId: qr.keyId, qrTimestampMs };
  // 8. 구역
  if (ticket.gateZone !== i.state.placement.gateZone) {
    return { result: 'REJECT', reason: 'WRONG_ZONE', direction, ticketId: qr.ticketId, keyId: qr.keyId, qrTimestampMs, ticketGateZone: ticket.gateZone };
  }
  // 9. 입장 상태
  const lastEntry = i.state.entries.get(qr.ticketId);
  if (direction === 'IN') {
    if (lastEntry) {
      if (!i.state.reentryAllowed) return { result: 'REJECT', reason: 'ALREADY_IN', direction, ticketId: qr.ticketId, keyId: qr.keyId, qrTimestampMs, lastEntry };
      if (lastEntry.lastDirection === 'IN') return { result: 'CHECK', reason: 'NO_EXIT_RECORD', direction, ticketId: qr.ticketId, keyId: qr.keyId, qrTimestampMs, seatLabel: ticket.seatLabel, lastEntry };
    }
  } else if (!lastEntry || lastEntry.lastDirection === 'OUT') {
    return {
      result: 'CHECK',
      reason: 'NO_ENTRY_RECORD',
      direction,
      ticketId: qr.ticketId,
      keyId: qr.keyId,
      qrTimestampMs,
      seatLabel: ticket.seatLabel,
      ...(lastEntry ? { lastEntry } : {}),
    };
  }
  // 10. 통과
  return { result: 'PASS', direction, ticketId: qr.ticketId, keyId: qr.keyId, qrTimestampMs, seatLabel: ticket.seatLabel };
}

/** 판정 화면 문구(d5 §8.3 판정 표) */
export function messageOf(o: JudgeOutcome): string {
  if (o.result === 'PASS') return '통과';
  if (o.result === 'RETRY') return '다시 찍어 주세요';
  if (o.result === 'CHECK') return o.reason === 'NO_EXIT_RECORD' ? '퇴장 기록 없음' : '입장 기록 없음';
  switch (o.reason) {
    case 'INVALID_QR':
    case 'UNSUPPORTED_VERSION':
      return '유효하지 않은 QR입니다';
    case 'UNKNOWN_TICKET':
      return '이 회차 티켓이 아니거나 발권되지 않은 티켓입니다';
    case 'TICKET_CANCELLED':
      return '취소되었거나 무효가 된 티켓입니다';
    case 'KEY_REVOKED':
      return '양도·취소·재발급된 티켓의 옛 QR입니다';
    case 'KEY_UNKNOWN':
      return '키가 아직 반영되지 않았습니다. 부스나 책임자에게 안내하세요';
    case 'BAD_SIGNATURE':
      return '위조가 의심됩니다';
    case 'QR_EXPIRED':
      return '유효시간이 지난 QR입니다';
    case 'WRONG_ZONE':
      return `다른 게이트 티켓입니다(${o.ticketGateZone ?? ''})`;
    case 'ALREADY_IN':
      return `이미 입장한 티켓입니다(${o.lastEntry ? kstHourMinute(o.lastEntry.lastAtMs) : '--:--'}, ${o.lastEntry?.gateZone ?? ''})`;
  }
}
