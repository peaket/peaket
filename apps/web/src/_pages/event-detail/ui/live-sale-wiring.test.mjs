// 리뷰 지적 R040-1 재현(계획 '리뷰 뒤 정한 것' RV5, ADR-0272 결정 1 '읽는 때'): 공연 상세 화면 코드는 상태 파일 가게를 직접 몰지 않고
// 받기 운전자(model/live-sale-store.ts createLiveSaleDriver)를 거친다. 오픈 순간 받기를 막는 규칙이 운전자 한 곳에 있게 한다.
// 소스를 읽어 본다(ui/no-render-clock.test.mjs와 같은 방식).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('[R040-1] 공연 상세 화면 코드는 상태 파일 가게의 start()·onVisible()을 직접 부르지 않고 받기 운전자를 거친다', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const files = readdirSync(dir).filter((n) => /\.tsx?$/.test(n));
  assert.ok(files.includes('sale-live.ts') && files.includes('Booking.tsx'), '본 파일이 있다(빈 목록이 통과로 새지 않게)');
  for (const n of files) {
    const src = stripComments(readFileSync(join(dir, n), 'utf8'));
    assert.equal(/\.start\(/.exec(src)?.[0], undefined, `${n}: .start(`);
    assert.equal(/\.onVisible\(/.exec(src)?.[0], undefined, `${n}: .onVisible(`);
  }
  assert.match(stripComments(readFileSync(join(dir, 'sale-live.ts'), 'utf8')), /\bcreateLiveSaleDriver\b/, 'sale-live.ts가 받기 운전자를 쓴다');
});

test('[V040-28] useDeniedMarker는 deniedHashCleanUrl의 값으로 history.replaceState를 부른다', () => {
  // 계획 '검증 뒤 정한 것' VV4, ADR-0272 결정 4 'history.replaceState로 주소 조각만 지운다'. 실제 주소는 브라우저 확인 B5가 본다
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const src = stripComments(readFileSync(join(dir, 'sale-live.ts'), 'utf8'));
  const at = src.indexOf('export function useDeniedMarker');
  assert.ok(at >= 0, 'useDeniedMarker가 있다');
  const rest = src.slice(at + 1);
  const next = rest.search(/\nexport /);
  const body = next < 0 ? rest : rest.slice(0, next);
  const made = /(?:const|let)\s+(\w+)\s*=\s*deniedHashCleanUrl\(/.exec(body);
  assert.ok(made, 'deniedHashCleanUrl(의 결과를 이름에 담는다');
  const call = /history\.replaceState\(\s*[^,()]+(?:\([^()]*\))?[^,()]*,\s*[^,()]+,\s*(\w+)\s*\)/.exec(body);
  assert.ok(call, 'history.replaceState(를 부른다');
  assert.equal(call[1], made[1], 'replaceState의 셋째 인자가 deniedHashCleanUrl의 결과다');
});
