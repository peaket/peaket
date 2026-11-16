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

/** 주석 뺀 sale-live.ts의 useDeniedMarker 본문 */
function deniedMarkerBody() {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const src = stripComments(readFileSync(join(dir, 'sale-live.ts'), 'utf8'));
  const at = src.indexOf('export function useDeniedMarker');
  assert.ok(at >= 0, 'useDeniedMarker가 있다');
  const rest = src.slice(at + 1);
  const next = rest.search(/\nexport /);
  return next < 0 ? rest : rest.slice(0, next);
}

test('[V040-28] useDeniedMarker는 takeDeniedMarker가 돌려준 cleanUrl(deniedHashCleanUrl의 값)로 history.replaceState를 부른다', () => {
  // 계획 '검증 뒤 정한 것' VV4를 '웨이브 끝 리뷰 뒤 정한 것'(W7L2-S2)에 맞춰 바꿈. ADR-0272 결정 4 'history.replaceState로 주소 조각만 지운다'. 실제 주소는 브라우저 확인 B5가 본다
  const body = deniedMarkerBody();
  const call = /history\.replaceState\(\s*[^,()]+(?:\([^()]*\))?[^,()]*,\s*[^,()]+,\s*([\w.]+)\s*\)/.exec(body);
  assert.ok(call, 'history.replaceState(를 부른다');
  const arg = call[1];
  // 두 모양: const r = takeDeniedMarker(…) → r.cleanUrl, 또는 const { cleanUrl, … } = takeDeniedMarker(…) → cleanUrl
  const named = /(?:const|let)\s+(\w+)\s*=\s*takeDeniedMarker\(/.exec(body);
  const destructured = /(?:const|let)\s*\{[^}]*\bcleanUrl\b(?:\s*:\s*(\w+))?[^}]*\}\s*=\s*takeDeniedMarker\(/.exec(body);
  const ok = (named && arg === `${named[1]}.cleanUrl`) || (destructured && arg === (destructured[1] ?? 'cleanUrl'));
  assert.ok(ok, `replaceState의 셋째 인자(${arg})가 takeDeniedMarker 결과의 cleanUrl이다`);
});

test('[W7L2-S2] useDeniedMarker는 takeDeniedMarker에 sessionStorage를 넘기고, 조각만으로 켜지 않는다', () => {
  // 계획 '웨이브 끝 리뷰 뒤 정한 것' WS6, ADR-0272 결정 4 '출처 확인': 켤지는 대기실 표시와 조각의 짝으로 takeDeniedMarker만 정한다
  const body = deniedMarkerBody();
  assert.match(body, /\btakeDeniedMarker\(/, 'takeDeniedMarker(를 부른다');
  assert.match(body, /\bsessionStorage\b/, 'sessionStorage를 넘긴다');
  for (const direct of ['deniedWindow(', 'isDeniedHash(', 'deniedHashCleanUrl(']) assert.ok(!body.includes(direct), `${direct}를 직접 부르지 않는다(조각만 보고 켜는 길이 없다)`);
});
