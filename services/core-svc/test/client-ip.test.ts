// A2-19 리뷰 R2(W7-audit): 명단 접속기록의 접속지 정보는 요청의 클라이언트 IP다(docs/features/settlement.md §9 '접속지', docs/infra.md §3 입구 규칙 2).
// identity-svc 관리 계정 로그인의 clientIpOf와 같은 규칙: 입구가 하나로 다시 쓴 x-forwarded-for가 IP 모양이면 그것, 아니면 연결 상대 주소, 둘 다 없으면 ''.
import { describe, expect, test } from 'vitest';
import { clientIpOf } from '../src/modules/export/inbound/client-ip.js';

type Req = Parameters<typeof clientIpOf>[0];
const req = (xff: string | string[] | undefined, remoteAddress: string | undefined): Req =>
  ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress } }) as unknown as Req;

describe('A2-19 R2 클라이언트 IP', () => {
  test('A2-19 R2 클라이언트 IP는 다시 쓴 x-forwarded-for가 IP일 때만 그것이고 아니면 연결 주소다', () => {
    const conn = '10.0.0.9';
    expect(clientIpOf(req('203.0.113.7', conn))).toBe('203.0.113.7');
    expect(clientIpOf(req(' 203.0.113.7 ', conn))).toBe('203.0.113.7');
    expect(clientIpOf(req('2001:db8::1', conn))).toBe('2001:db8::1');
    // 배열이면 첫 값
    expect(clientIpOf(req(['198.51.100.1', '203.0.113.7'], conn))).toBe('198.51.100.1');
    // 쉼표 목록·IP 모양이 아닌 값·빈 값은 연결 주소
    expect(clientIpOf(req('203.0.113.7, 10.0.0.1', conn))).toBe(conn);
    expect(clientIpOf(req('not-an-ip', conn))).toBe(conn);
    expect(clientIpOf(req('', conn))).toBe(conn);
    expect(clientIpOf(req(undefined, conn))).toBe(conn);
    // 머리도 연결 주소도 없으면 빈 문자열(부르는 쪽이 접속지 없음으로 거절한다)
    expect(clientIpOf(req(undefined, undefined))).toBe('');
    expect(clientIpOf({ headers: {} } as unknown as Req)).toBe('');
  });
});
