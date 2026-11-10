// 시작 순서(낮음 9): 경고 함수를 단 뒤에 ASN 분류표 읽기를 시작해야 처음 읽기 실패 경고를 잃지 않는다.
// 운영 조립은 start.ts에 있다(main.ts는 환경 값과 SIGTERM만 잇는다, BUILD_ORDER PRF-215)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('낮음9_ASN분류표읽기는경고함수를단뒤에시작한다', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/start.ts', import.meta.url)), 'utf8');
  const warn = src.indexOf('asnLog.warn =');
  const start = src.indexOf('asnTable.start()');
  expect(warn).toBeGreaterThan(-1);
  expect(start).toBeGreaterThan(warn);
});

test('[Q-T39] 최초방문쿠키키가없거나틀려도_시작을막지않고경고로끝낸다', () => {
  const main = readFileSync(fileURLToPath(new URL('../src/start.ts', import.meta.url)), 'utf8');
  expect(main).toMatch(/HmacFirstVisitCookies\.fromEnv\(env, \(m\) => firstVisitWarnings\.push\(m\)\)/);
  expect(main).toMatch(/for \(const w of firstVisitWarnings\) service\.logger\.warn/);
});
