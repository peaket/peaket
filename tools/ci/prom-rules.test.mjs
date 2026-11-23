// Prometheus 규칙 검사·시험 실행기의 명령줄 시험(F-01-5, OPS-090, 시험 V-T51 ⑧, 계획 docs/review/plans/F-01-5.md §5 '실행기').
// 실행기를 바깥에서 돌린다: node tools/ci/prom-rules.mjs <check|test> [--root <임시 저장소>].
// 임시 저장소에는 deploy/platform/observability/와 promtool 이미지가 적힌 deploy/local/observability.yaml을 복사하고 사례마다 한 곳을 바꾼다.
// 끝 코드 0 통과, 1 실패(파일마다 '막음: <파일>: <까닭>'), 2 인자 오류·파일 없음·시험 파일 0개·Docker와 PEAKET_PROMTOOL이 모두 없음.
// 도구가 없거나 시험이 0개인 것을 통과로 내지 않는지 본다(docs/verification.md §2.7, ADR-0069 결정 1과 같은 뜻).
// 실행(저장소 뿌리): node --test tools/ci/prom-rules.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { tempDir } from './git-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'prom-rules.mjs');
const REPO = resolve(HERE, '..', '..');
const OBS = 'deploy/platform/observability';
const TEST_DIR = `${OBS}/test`;
const ONSALE = `${OBS}/rules/slo-onsale.yaml`;
const R28D = `${OBS}/rules/slo-28d.yaml`;
const AGG = `${OBS}/rules/agg5m.yaml`;
const REALTIME = `${OBS}/alerts/realtime-gw.yaml`;
const MIMIR = `${OBS}/mimir/rules/slo-budget28d.yaml`;
const LOCAL_OBS = 'deploy/local/observability.yaml';

function cli(args, env = process.env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: REPO, env });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
const blockedFiles = (out) =>
  out
    .split(/\r?\n/)
    .filter((l) => l.startsWith('막음:'))
    .map((l) => l.split(': ')[1])
    .sort();
const readIn = (root, rel) => readFileSync(join(root, rel), 'utf8');

function fixture() {
  const root = tempDir('prom-rules-');
  cpSync(join(REPO, OBS), join(root, OBS), { recursive: true });
  mkdirSync(join(root, 'deploy/local'), { recursive: true });
  cpSync(join(REPO, LOCAL_OBS), join(root, LOCAL_OBS));
  return root;
}
/** 시험 폴더에 그 파일의 묶음 가운데 이름이 prefix로 시작하는 것만 남긴다(나머지 시험 파일은 지운다) */
function onlyTests(root, keep) {
  rmSync(join(root, TEST_DIR), { recursive: true, force: true });
  mkdirSync(join(root, TEST_DIR), { recursive: true });
  for (const [file, prefix] of keep) {
    const spec = parse(readIn(REPO, `${TEST_DIR}/${file}`));
    const tests = spec.tests.filter((t) => t.name.startsWith(prefix));
    assert.ok(tests.length >= 1, `${file}: '${prefix}' 묶음이 없다`);
    writeFileSync(join(root, TEST_DIR, file), stringify({ ...spec, tests }, { lineWidth: 0 }));
  }
}
/** 규칙 파일의 첫 묶음 첫 규칙 식을 PromQL로 읽히지 않는 식으로 바꾼다 */
function breakFirstRule(root, rel, crd = true) {
  const doc = parse(readIn(root, rel));
  const groups = crd ? doc.spec.groups : doc.groups;
  groups[0].rules[0].expr = 'sum(rate(http_server_request_duration_seconds_count[5m])';
  writeFileSync(join(root, rel), stringify(doc, { lineWidth: 0 }));
}

test('V-T51 ⑧ 실행기는 명령·인자가 틀리거나 저장소가 없으면 2로 끝난다', () => {
  for (const args of [[], ['lint'], ['check', '--root'], ['test', '--root', join(tempDir('prom-rules-none-'), 'no-such-repo')], ['check', '--bogus']]) {
    const r = cli(args);
    assert.equal(r.status, 2, `${JSON.stringify(args)}: ${r.out}`);
    assert.deepEqual(blockedFiles(r.out), []);
  }
});

test('V-T51 ⑧ 시험 파일이 0개면 test는 통과가 아니라 2다', () => {
  const root = fixture();
  rmSync(join(root, TEST_DIR), { recursive: true, force: true });
  mkdirSync(join(root, TEST_DIR), { recursive: true });
  const r = cli(['test', '--root', root]);
  assert.equal(r.status, 2, r.out);
  // 시험 폴더가 아예 없어도 같다
  rmSync(join(root, TEST_DIR), { recursive: true, force: true });
  assert.equal(cli(['test', '--root', root]).status, 2);
});

test('V-T51 ⑧ Docker도 PEAKET_PROMTOOL도 없으면 check·test가 2다', () => {
  const root = fixture();
  onlyTests(root, [['slo-budget28d.test.yaml', 'V-T51 ⑦']]);
  // PATH를 빈 폴더 하나로 둬서 docker를 찾지 못하게 한다(Windows의 Path 이름도 지운다)
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^path$/i.test(k) && k !== 'PEAKET_PROMTOOL'));
  env.PATH = tempDir('prom-rules-nopath-');
  for (const cmd of ['check', 'test']) {
    const r = cli([cmd, '--root', root], env);
    assert.equal(r.status, 2, `${cmd}: ${r.out}`);
    assert.deepEqual(blockedFiles(r.out), []);
  }
});

test('V-T51 ⑧ check는 rules·alerts·mimir/rules의 틀린 규칙을 파일마다 막는다', () => {
  // 바꾸지 않은 사본은 0이다
  const clean = fixture();
  const ok = cli(['check', '--root', clean]);
  assert.equal(ok.status, 0, ok.out);
  assert.deepEqual(blockedFiles(ok.out), []);
  // 세 자리를 하나씩 깨면 그 파일만 막는다(CRD는 spec을 꺼내 검사한다)
  const root = fixture();
  breakFirstRule(root, ONSALE);
  breakFirstRule(root, REALTIME);
  breakFirstRule(root, MIMIR, false);
  const r = cli(['check', '--root', root]);
  assert.equal(r.status, 1, r.out);
  assert.deepEqual(blockedFiles(r.out), [REALTIME, MIMIR, ONSALE].sort());
  for (const untouched of [R28D, AGG]) assert.ok(!blockedFiles(r.out).includes(untouched), untouched);
});

test('V-T51 ⑧ 규칙 이름이 시험과 다르면 check는 0이어도 test가 1이고 그 시험 파일만 막는다', () => {
  const root = fixture();
  onlyTests(root, [['slo-onsale.test.yaml', 'V-T51 ⑤'], ['slo-budget28d.test.yaml', 'V-T51 ⑦']]);
  const base = cli(['test', '--root', root]);
  assert.equal(base.status, 0, base.out);
  // 자동 감축이 읽는 이름(ADR-0226 결정 5)을 다른 이름으로 바꾼다. PromQL로는 맞는 규칙이다
  writeFileSync(join(root, ONSALE), readIn(root, ONSALE).replaceAll('peaket:slo:budget_burn50:state', 'peaket:slo:budget_burn_50:state'));
  assert.equal(cli(['check', '--root', root]).status, 0);
  const r = cli(['test', '--root', root]);
  assert.equal(r.status, 1, r.out);
  assert.deepEqual(blockedFiles(r.out), [`${TEST_DIR}/slo-onsale.test.yaml`]);
  assert.match(r.out, /V-T51 ⑤/);
});
