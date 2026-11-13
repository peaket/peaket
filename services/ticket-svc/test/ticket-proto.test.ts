// proto 계약 시험(BUILD_ORDER HOT-160, BAT-050): ticket.proto의 최소 RPC·필드·enum이 생성 설명에 있는지 본다.
import * as protoLoader from '@grpc/proto-loader';
import { describe, expect, test } from 'vitest';
import { ticketV1Ticket } from '@peaket/contracts/proto';

const def = protoLoader.fromJSON(ticketV1Ticket as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
const root = (def as unknown as { nested: Record<string, unknown> });
const json = JSON.stringify(root);

describe('ticket.proto [HOT-160]', () => {
  test('TicketService에 IssueTickets·CancelTickets·ListTickets가 있다', () => {
    for (const rpc of ['IssueTickets', 'CancelTickets', 'ListTickets']) expect(json).toContain(`"${rpc}"`);
  });

  test('발권 응답은 티켓 키·QR 페이로드·회차를, 요청은 회차 시작 시각을 싣는다', () => {
    for (const field of ['ticket_key', 'qr_payload', 'event_starts_at']) expect(json).toContain(`"${field}"`);
  });

  test('월렛 목록과 이미 취소된 결과가 계약에 있다', () => {
    expect(json).toContain('"ListTicketsRequest"');
    expect(json).toContain('"WalletTicket"');
    expect(json).toContain('CANCEL_TICKET_RESULT_ALREADY_CANCELLED');
  });
});
