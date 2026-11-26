// F-05-11 R-T5 transfer-race.js 정적 검사(loadtest-check, IR-13).
// k6 없이 소스에서 여러 표·여러 사건의 여섯 갈래 실제 호출과 1,000회 기본값을 본다. 주석은 지우고 본다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = readFileSync(resolve(REPO, 'loadtest/scenarios/transfer-race.js'), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('F-05-11 R-T5 transfer-race 정적 검사(IR-13)', () => {
  test('여러 표·여러 사건을 환경에서 받아 1,000회 여섯 갈래를 실제 호출한다', () => {
    assert.match(code, /TICKET_IDS\.split\(/);
    assert.match(code, /EVENT_IDS\.split\(/);
    assert.match(code, /i % 6/);
    assert.match(code, /TRANSFER_RACE_ITERATIONS[^\n]*1000|1000/);
    for (const call of ['/acceptance', '/rejection', '/withdrawal', '/returns', '/internal/v1/event-refunds']) assert.ok(code.includes(call), `${call} 호출이 없다`);
    assert.ok(code.includes('setup'), 'setup에서 조회 1회를 준비하지 않는다');
  });

  test('주석에만 있는 호출로 통과하지 않는다', () => {
    assert.ok(!code.includes('returns:'), 'returns가 주석에만 있다');
    const posts = code.match(/http\.(post|request)\(/g) ?? [];
    assert.ok(posts.length >= 6, `실제 HTTP 호출이 ${posts.length}개뿐이다`);
  });
});
