// 운영 조립(start.ts)의 종료 차례(BUILD_ORDER PRF-215 변이 검토): 시작 파일을 start({ env })로 나눈 뒤에도 Redis·DB 풀은 소비자·실행기를 멈추고 서비스를 닫은 뒤에만 닫는다.
// 먼저 닫으면 돌던 틱·소비자의 마지막 쓰기가 닫힌 연결에 부딪힌다. 실제로 띄워 보는 것은 services/bundle/test-int/start-files.int.test.ts다(SIGTERM 코드 0).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const source = (): string =>
  readFileSync(fileURLToPath(new URL('../src/start.ts', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

test('PRF215_변이검토_start.ts 종료는 소비자·실행기를 멈추고 서비스를 닫은 뒤에만 좌석 Redis와 DB 풀을 닫는다', () => {
  const closing = source().slice(source().indexOf('function shutdown('));
  const serviceClose = closing.indexOf('service.close()');
  expect(serviceClose, 'shutdown이 서비스를 닫는다').toBeGreaterThan(-1);
  expect(closing.indexOf('consumers?.stop()'), '소비자 멈추기 < 서비스 닫기').toBeLessThan(serviceClose);
  expect(closing.indexOf('sweeper.stop()'), '만료 반복 멈추기 < 서비스 닫기').toBeLessThan(serviceClose);
  for (const conn of ['redis.close()', 'database?.close()', 'consumerDatabase?.close()', 'ticketIssueDatabase?.close()', 'paymentPullDatabase?.close()', 'orderExpiryDatabase?.close()', 'saleStateDatabase?.close()']) {
    const at = closing.indexOf(conn);
    expect(at, `${conn}를 닫는다`).toBeGreaterThan(-1);
    expect(at, `${conn} > 서비스 닫기`).toBeGreaterThan(serviceClose);
    expect(closing.indexOf(conn, at + 1), `${conn}는 한 번만`).toBe(-1);
  }
});
