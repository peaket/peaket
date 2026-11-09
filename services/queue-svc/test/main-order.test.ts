// 시작 순서(낮음 9): 경고 함수를 단 뒤에 ASN 분류표 읽기를 시작해야 처음 읽기 실패 경고를 잃지 않는다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('낮음9_ASN분류표읽기는경고함수를단뒤에시작한다', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');
  const warn = src.indexOf('asnLog.warn =');
  const start = src.indexOf('asnTable.start()');
  expect(warn).toBeGreaterThan(-1);
  expect(start).toBeGreaterThan(warn);
});
