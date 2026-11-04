// 제3자 고지 파일 시험(ADR-0040 결정 7, wbs 0.6.2, BUILD_ORDER BAS-180).
// 앱 번들에 SEED가 들어가므로 Apache-2.0 제4조대로 라이선스 사본과 NOTICE 귀속 고지를 고지 파일에 싣는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderNotices, seedPackages, NOTICES_PATH } from '../scripts/build-notices.mjs';

const dsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dsPkg = JSON.parse(readFileSync(join(dsDir, 'package.json'), 'utf8'));
const pkgs = seedPackages();
const raw = (p) => readFileSync(p, 'utf8').replaceAll('\r\n', '\n').replace(/\s+$/, '');

test('ADR-0040 ds가 잇는 @seed-design 패키지(직접 의존성과 그 하위 SEED 패키지)를 모두 이름·판으로 싣는다', () => {
  const text = renderNotices();
  const direct = Object.keys({ ...dsPkg.dependencies }).filter((n) => n.startsWith('@seed-design/'));
  assert.ok(direct.length > 0, 'ds가 잇는 @seed-design 패키지가 없다');
  for (const n of direct) assert.ok(pkgs.some((p) => p.name === n), `${n}을 찾지 못했다`);
  for (const p of pkgs) assert.ok(text.includes(`${p.name} ${p.version}`), `${p.name} ${p.version}이 고지에 없다`);
  assert.match(text, /github\.com\/daangn\/seed-design/);
});

test('ADR-0040 고지는 패키지마다의 NOTICE 귀속 고지와 라이선스 전문을 글자 그대로(앞 공백 포함) 싣는다', () => {
  const text = renderNotices();
  for (const p of pkgs) {
    if (p.noticePath) assert.ok(text.includes(raw(p.noticePath)), `${p.name} NOTICE 전문이 없다`);
    assert.ok(p.licensePath, `${p.name}에 LICENSE 파일이 없다`);
    assert.ok(text.includes(raw(p.licensePath)), `${p.name} LICENSE 전문이 없다`);
  }
  // Apache-2.0 전문의 첫 줄은 가운데 맞춤 공백으로 시작한다(다듬어 지우지 않는다)
  assert.match(text, /\n {10,}Apache License\n/);
});

test('ADR-0040 저장소의 고지 파일이 붙인 SEED 판으로 만든 것과 같다(판을 올리거나 SEED 패키지를 더하면 다시 만든다)', () => {
  const onDisk = readFileSync(NOTICES_PATH, 'utf8').replaceAll('\r\n', '\n');
  assert.equal(onDisk, renderNotices(), "다르면 'pnpm --filter @peaket/ds notices'로 다시 만든다");
});
