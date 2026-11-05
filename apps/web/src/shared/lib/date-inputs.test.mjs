// 날짜 칸(type이 date·datetime-local·month·week인 입력, 부품 포함)은 max로 연도를 네 자리로 막는다. max가 없으면 Chrome은 여섯 자리 연도(275760년까지)를 받아,
// 키보드로 20261201을 치면 연도가 202612가 되고 월·일로 넘어가지 않는다(2026-11-05 Chrome 브라우저 확인, HOT-312 리뷰 '확인 필요')
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../..', import.meta.url));

function* tsxFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* tsxFiles(p);
    else if (p.endsWith('.tsx')) yield p;
  }
}

test('소비자 웹의 날짜 칸(date·datetime-local·month·week)은 모두 max가 있어 연도가 네 자리다', () => {
  const missing = [];
  let seen = 0;
  for (const file of tsxFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    // JSX 속성 안의 화살표 함수(=>)에도 >가 있어, 스스로 닫는 꼬리표(/>)까지를 한 칸으로 본다. 꼬리표 이름은 input이 아니어도 된다(부품).
    // 사이 글자는 새 여는 꼬리표(<글자)를 넘지 못한다(바깥 꼬리표의 max=로 통과하지 않게)
    for (const m of text.matchAll(/<[A-Za-z][\w.]*\b(?:(?!\/>|<[A-Za-z])[\s\S])*?\btype=(?:"|'|\{\s*['"`])(?:date|datetime-local|month|week)['"`](?:(?!\/>|<[A-Za-z])[\s\S])*\/>/g)) {
      seen += 1;
      if (!/\bmax=/.test(m[0])) missing.push(`${relative(SRC, file)}: ${m[0].slice(0, 80)}`);
    }
  }
  assert.ok(seen > 0, '날짜 칸을 하나도 찾지 못했다(찾는 식이 틀렸다)');
  assert.deepEqual(missing, []);
});
