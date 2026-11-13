// 티켓 순수 규칙 시험(BUILD_ORDER HOT-160, BAT-050): 멱등 지문·키/QR·커서·입력 검사.
import { describe, expect, test } from 'vitest';
import {
  issueFingerprint,
  isUuid,
  newTicketKey,
  normalizeIssueInput,
  parseWalletCursor,
  qrPayloadOf,
  TicketInputError,
  ticketKeyHash,
  walletCursorOf,
} from '../src/modules/ticket/domain/ticket.js';

const ORDER = '0190f3a1-7c2e-7a00-8000-000000000001';
const EVENT = '0190f3a1-7c2e-7a00-8000-000000000002';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000003';
const SEAT_A = '0190f3a1-7c2e-7a00-8000-000000000004';
const SEAT_B = '0190f3a1-7c2e-7a00-8000-000000000005';
const input = (over: Partial<Parameters<typeof normalizeIssueInput>[0]> = {}) => ({ orderId: ORDER, eventId: EVENT, payerAccountId: ACCOUNT, seatIds: [SEAT_A, SEAT_B], issueGeneration: 0, ...over });

describe('ticket domain [HOT-160]', () => {
  test('같은 주문·세대·좌석은 좌석 차례와 관계없이 같은 지문이고, 내용이 다르면 다른 지문이다', () => {
    const a = issueFingerprint(input());
    expect(issueFingerprint(input({ seatIds: [SEAT_B, SEAT_A] }))).toBe(a);
    expect(issueFingerprint(input({ eventStartsAtMs: 1_700_000_000_000 }))).toBe(a);
    expect(issueFingerprint(input({ issueGeneration: 1 }))).not.toBe(a);
    expect(issueFingerprint(input({ seatIds: [SEAT_A] }))).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test('좌석은 중복을 없애고 정렬하며, 빈 값·UUID 아님·상한 초과를 거절한다', () => {
    expect(normalizeIssueInput(input({ seatIds: [SEAT_B, SEAT_A, SEAT_B] })).seatIds).toEqual([SEAT_A, SEAT_B]);
    expect(() => normalizeIssueInput(input({ seatIds: [] }))).toThrow(TicketInputError);
    expect(() => normalizeIssueInput(input({ seatIds: ['nope'] }))).toThrow(TicketInputError);
    expect(() => normalizeIssueInput(input({ seatIds: Array.from({ length: 11 }, (_, i) => `0190f3a1-7c2e-7a00-8000-0000000000${String(i).padStart(2, '0')}`) }))).toThrow(TicketInputError);
    expect(() => normalizeIssueInput(input({ issueGeneration: -1 }))).toThrow(TicketInputError);
  });

  test('티켓 키는 32바이트 base64url이고 해시는 안정적이며 QR은 공개 포인터다', () => {
    const key = newTicketKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ticketKeyHash(key)).toBe(ticketKeyHash(key));
    expect(ticketKeyHash(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(qrPayloadOf(ORDER)).toBe(`PEAKET1:${ORDER}`);
    expect(qrPayloadOf(ORDER)).not.toContain(key);
  });

  test('월렛 커서는 왕복하고, 망가진 커서는 버린다', () => {
    const c = { issuedAtMs: 1_700_000_000_000, ticketId: ORDER };
    expect(parseWalletCursor(walletCursorOf(c))).toEqual(c);
    expect(parseWalletCursor('not-base64')).toBeUndefined();
    expect(parseWalletCursor(Buffer.from('["x","y"]').toString('base64url'))).toBeUndefined();
  });

  test('UUID 검사는 대소문자를 받아들이고 다른 모양은 거절한다', () => {
    expect(isUuid(ORDER.toUpperCase())).toBe(true);
    expect(isUuid('0190f3a1-7c2e-7a00-8000-00000000000')).toBe(false);
    expect(isUuid('')).toBe(false);
  });
});
