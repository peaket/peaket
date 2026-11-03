// 시험용 게이트웨이 대역(scripts/local-gateway.mjs, docs/features/seat-hold.md §14 '로컬 실행')의 재현 시험.
// 새 맥락 코드 리뷰가 찾은 결함: 열린 리디렉트(\·탭), 깨진 퍼센트 인코딩·제어 문자로 프로세스가 죽음, 브라우저가 보낸 x-session-id를 지우지 않음,
// Host 확인 없음(DNS 리바인딩)
import { describe, expect, test } from 'vitest';
import * as gw from '../scripts/local-gateway.mjs';

const g = gw as unknown as {
  forwardHeaders(h: Record<string, string>, upstreamHost: string): Record<string, string>;
  safeNext(next: string | null): string | undefined;
  parseAsPath(pathname: string): string | undefined;
  hostAllowed(host: string | undefined, port: number): boolean;
};

describe('게이트웨이 대역', () => {
  test('ASVS_8_2_1_브라우저가보낸신원머리는x-session-id까지모두지운다 [ASVS v5.0.0-8.2.1]', () => {
    const out = g.forwardHeaders({ 'x-session-id': 'forged', 'x-user-id': 'forged', 'x-user-pid': 'forged', accept: 'text/html' }, '127.0.0.1:8080');
    expect(out).toEqual({ accept: 'text/html', host: '127.0.0.1:8080' });
  });

  test('FR009_시험계정고르기의next는같은사이트경로만받는다', () => {
    expect(g.safeNext('/v0/seatmap/demo-1?x=1')).toBe('/v0/seatmap/demo-1?x=1');
    // 2차 리뷰: 경로를 정리하면 //로 시작하게 되는 입력(/..//, /.//, %2e%2e)도 거절한다
    const bad = ['/\\evil.example', '/\t/evil.example', '//evil.example', 'http://evil.example/', '/\r\nSet-Cookie:x=1', '', null];
    bad.push('/..//evil.com', '/.//evil.com', '/%2e%2e//evil.com', '/a/..//evil.com');
    for (const bad1 of bad) {
      const bad = bad1;
      expect(g.safeNext(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  test('FR009_시험계정이름이깨진퍼센트인코딩이어도_던지지않고거절한다', () => {
    expect(g.parseAsPath('/__as/user1')).toBe('user1');
    expect(g.parseAsPath('/__as/%E0%A4%A')).toBeUndefined();
    expect(g.parseAsPath('/__as/a%2Fb')).toBeUndefined();
    expect(g.parseAsPath('/other')).toBeUndefined();
  });

  test('FR009_Host가루프백주소가아니면받지않는다', () => {
    expect(g.hostAllowed('127.0.0.1:8088', 8088)).toBe(true);
    expect(g.hostAllowed('localhost:8088', 8088)).toBe(true);
    expect(g.hostAllowed('evil.example:8088', 8088)).toBe(false);
    expect(g.hostAllowed('127.0.0.1:9999', 8088)).toBe(false);
    expect(g.hostAllowed(undefined, 8088)).toBe(false);
  });
});
