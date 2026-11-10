// 외부 보안 검사 도구 고정 표·받기·실행 인자(tools/ci/scan-tools.mjs) 시험(docs/devops.md §3.1 gitleaks·Trivy 줄·§4.4 '외부 보안 검사 게이트',
// ADR-0263 결정 1·2·7, ASVS 13.3.1, BUILD_ORDER BAS-011 ②). 실행: node --test "tools/ci/*.test.mjs"
// 받기 시험은 진짜 주소에 닿지 않는다(받는 함수를 넘긴다). 고정 값은 ADR-0263 결정 1의 값을 글자 그대로 적는다.
// 시험 자료에 비밀 꼴 글자를 쓰지 않는다(이 저장소의 gitleaks가 시험 파일도 본다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { tempDir } from './git-fixture.mjs';
import {
  DecoyError,
  CONFIG_DECOY,
  TRIVY_BUILTIN_ALLOW_RULES,
  configDecoyProblems,
  findInlineIgnores,
  imageDecoyProblems,
  runTrivyConfig,
  runTrivyImage,
  writeImageDecoy,
  IAC_TARGETS,
  PINS,
  decoySecret,
  extractTarMember,
  fetchGitleaks,
  gitleaksConfigProblems,
  gitleaksDecoyArgs,
  gitleaksHistoryArgs,
  gitleaksIgnoreProblems,
  missingIacTargets,
  runGitleaks,
  trivyConfigArgs,
  trivyImageArgs,
} from './scan-tools.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const YAML = await import('yaml').catch(() => null);
const hash = (b) => createHash('sha256').update(b).digest('hex');
// 같은 다이제스트를 GHCR에서 받는다(devops §4.4 '리뷰 뒤 더한 규칙' ④)
const TRIVY = 'ghcr.io/aquasecurity/trivy@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c';

/** ustar 묶음(파일 이름 → 내용). 종류 '5'는 폴더 */
function tar(entries) {
  const blocks = [];
  for (const [name, body, type = '0'] of entries) {
    const data = Buffer.from(body);
    const h = Buffer.alloc(512);
    h.write(name, 0, 'utf8');
    h.write('0000755\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(type, 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    const sum = [...h].reduce((a, b) => a + b, 0);
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
const ARCHIVE = gzipSync(tar([['LICENSE', 'MIT'], ['README.md', '# gitleaks'], ['gitleaks', 'ELF-가짜-실행-파일']]));
const testPins = (sha) => ({ ...PINS, gitleaks: { version: '8.9.10', assets: { x64: { url: 'https://example.invalid/v8.9.10/gitleaks_8.9.10_linux_x64.tar.gz', sha256: sha } } } });

test('[ASVS v5.0.0-13.3.1] gitleaks는 고정 표의 주소에서 받고 SHA-256이 다르면 풀지 않고 실패한다(받아 둔 파일도 다시 잰다)', async () => {
  // 맞으면: 고정 표의 주소에서 받아 실행 파일 하나만 꺼낸다
  const out = tempDir('gitleaks-fetch-');
  const asked = [];
  const r = await fetchGitleaks({ out, arch: 'x64', pins: testPins(hash(ARCHIVE)), download: async (u) => (asked.push(u), ARCHIVE) });
  assert.deepEqual(asked, ['https://example.invalid/v8.9.10/gitleaks_8.9.10_linux_x64.tar.gz']);
  assert.equal(readFileSync(r.bin, 'utf8'), 'ELF-가짜-실행-파일');
  assert.equal(existsSync(join(out, 'LICENSE')), false, '다른 항목은 풀지 않는다');
  assert.equal(r.version, '8.9.10');
  // 받은 묶음의 해시가 다르면 묶음을 남기지 않고 실행 파일도 만들지 않는다
  const bad = tempDir('gitleaks-fetch-bad-');
  const tampered = gzipSync(tar([['gitleaks', '바꿔치기한-실행-파일']]));
  await assert.rejects(fetchGitleaks({ out: bad, arch: 'x64', pins: testPins(hash(ARCHIVE)), download: async () => tampered }), /SHA-256/);
  assert.equal(existsSync(join(bad, 'gitleaks')), false);
  assert.equal(existsSync(join(bad, 'gitleaks_8.9.10_linux_x64.tar.gz')), false);
  // 받아 둔 묶음이 바뀌었으면 다시 받지 않고 실패한다(이름만 보고 믿지 않는다)
  const cached = tempDir('gitleaks-fetch-cache-');
  writeFileSync(join(cached, 'gitleaks_8.9.10_linux_x64.tar.gz'), tampered);
  let called = 0;
  await assert.rejects(fetchGitleaks({ out: cached, arch: 'x64', pins: testPins(hash(ARCHIVE)), download: async () => (called++, ARCHIVE) }), /받아 둔 묶음/);
  assert.equal(called, 0);
  assert.equal(existsSync(join(cached, 'gitleaks')), false);
  // 받아 둔 묶음이 맞으면 받지 않고, 옆에 있던 낡은 실행 파일은 묶음의 것으로 덮는다
  const reuse = tempDir('gitleaks-fetch-reuse-');
  writeFileSync(join(reuse, 'gitleaks_8.9.10_linux_x64.tar.gz'), ARCHIVE);
  writeFileSync(join(reuse, 'gitleaks'), '낡은-실행-파일');
  const again = await fetchGitleaks({ out: reuse, arch: 'x64', pins: testPins(hash(ARCHIVE)), download: async () => assert.fail('받지 않는다') });
  assert.equal(readFileSync(again.bin, 'utf8'), 'ELF-가짜-실행-파일');
  // https가 아니거나 표에 없는 아키텍처, 64자리가 아닌 해시는 받지 않는다
  await assert.rejects(fetchGitleaks({ out: tempDir('g-'), arch: 'x64', pins: { ...PINS, gitleaks: { version: '1', assets: { x64: { url: 'http://example.invalid/a.tar.gz', sha256: hash(ARCHIVE) } } } }, download: async () => ARCHIVE }), /https/);
  await assert.rejects(fetchGitleaks({ out: tempDir('g-'), arch: 'ia32', download: async () => ARCHIVE }), /ia32/);
  await assert.rejects(fetchGitleaks({ out: tempDir('g-'), arch: 'x64', pins: testPins('abc'), download: async () => ARCHIVE }), /64자리/);
  // 묶음에 실행 파일이 없거나 둘이거나 일반 파일이 아니면 실패한다
  assert.throws(() => extractTarMember(tar([['README.md', 'x']]), 'gitleaks'), /없다/);
  assert.throws(() => extractTarMember(tar([['gitleaks', 'a'], ['./gitleaks', 'b']]), 'gitleaks'), /2개/);
  assert.throws(() => extractTarMember(tar([['gitleaks', '', '5']]), 'gitleaks'), /일반 파일/);
});

test('[ASVS v5.0.0-13.3.1] 고정 표는 판과 주소가 맞고 SHA-256은 64자리 16진, Trivy 이미지는 @sha256 다이제스트다', () => {
  assert.equal(PINS.gitleaks.version, '8.30.1');
  assert.deepEqual(Object.keys(PINS.gitleaks.assets).sort(), ['arm64', 'x64']);
  for (const [arch, a] of Object.entries(PINS.gitleaks.assets)) {
    assert.equal(a.url, `https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_${arch}.tar.gz`);
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
  }
  // ADR-0263 결정 1의 값
  assert.equal(PINS.gitleaks.assets.x64.sha256, '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb');
  assert.equal(PINS.gitleaks.assets.arm64.sha256, 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080');
  assert.equal(PINS.trivy.version, '0.76.1');
  assert.match(PINS.trivy.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(`${PINS.trivy.image}@${PINS.trivy.digest}`, TRIVY);
  assert.ok(Object.isFrozen(PINS) && Object.isFrozen(PINS.gitleaks.assets.x64) && Object.isFrozen(PINS.trivy));
});

test('[ASVS v5.0.0-13.3.1] gitleaks 인자에 설정 파일·무시 파일·--redact·누출 종료 코드가 있고 지금 커밋에서 닿는 전체 이력을 본다', () => {
  assert.deepEqual(gitleaksHistoryArgs({ config: 'c.toml', ignore: 'ig', sarif: 'out.sarif', repo: '.' }), [
    'git',
    '--config', 'c.toml',
    '--report-format', 'sarif',
    '--report-path', 'out.sarif',
    '--redact',
    '--exit-code', '99',
    '--no-banner',
    '--no-color',
    '--ignore-gitleaks-allow',
    '--gitleaks-ignore-path', 'ig',
    '--log-opts', '--full-history -m HEAD',
    '.',
  ]);
  // 예약 실행은 모든 가지·태그(--all)를, 모든 실행은 병합 커밋의 차이(-m)까지 본다(devops §4.4 '리뷰 뒤 더한 규칙' ⑤)
  const all = gitleaksHistoryArgs({ config: 'c.toml', ignore: 'ig', sarif: 'out.sarif', repo: '.', allRefs: true });
  assert.equal(all[all.indexOf('--log-opts') + 1], '--full-history -m --all');
  assert.deepEqual(all.filter((a, i) => all[i - 1] !== '--log-opts'), gitleaksHistoryArgs({ config: 'c.toml', ignore: 'ig', sarif: 'out.sarif', repo: '.' }).filter((a, i, xs) => xs[i - 1] !== '--log-opts'));
  // 미끼는 같은 설정·가림·종료 코드로 폴더를 본다
  assert.deepEqual(gitleaksDecoyArgs({ config: 'c.toml', sarif: 'd.sarif', dir: '/tmp/decoy' }), ['dir', '--config', 'c.toml', '--report-format', 'sarif', '--report-path', 'd.sarif', '--redact', '--exit-code', '99', '--no-banner', '--no-color', '--ignore-gitleaks-allow', '/tmp/decoy']);
  // 기본 설정·무시 파일은 tools/ci의 것이다
  const def = gitleaksHistoryArgs({ sarif: 's' });
  assert.equal(def[def.indexOf('--config') + 1], join(HERE, 'gitleaks.toml'));
  assert.equal(def[def.indexOf('--gitleaks-ignore-path') + 1], join(HERE, 'gitleaks-ignore'));
});

/** 가짜 gitleaks: 미끼 단계(dir)와 이력 단계(git)를 기록하고 정해 준 대로 결과를 쓴다 */
function fakeGitleaks({ decoyStatus = 99, decoyRule = 'github-pat', historyStatus = 0 } = {}) {
  const calls = [];
  const run = (bin, args) => {
    calls.push(args[0]);
    const sarif = args[args.indexOf('--report-path') + 1];
    if (args[0] === 'dir') {
      const dir = args.at(-1);
      const body = readFileSync(join(dir, 'settings.js'), 'utf8');
      calls.push(new RegExp(`'${'gh'}${'p_'}[0-9A-Za-z]{36}'`).test(body) ? '미끼 꼴 맞음' : '미끼 꼴 틀림');
      if (decoyRule !== null) writeFileSync(sarif, JSON.stringify({ runs: [{ tool: { driver: { name: 'gitleaks' } }, results: [{ ruleId: decoyRule }] }] }));
      return { status: decoyStatus };
    }
    writeFileSync(sarif, JSON.stringify({ runs: [{ tool: { driver: { name: 'gitleaks' } }, results: [] }] }));
    return { status: historyStatus };
  };
  return { run, calls };
}

test('[ASVS v5.0.0-13.3.1] 실행 때 만든 미끼 비밀을 못 찾으면 이력 검사 전에 실패한다', () => {
  const setup = () => {
    const repo = tempDir('gitleaks-repo-');
    const work = join(tempDir('gitleaks-work-'), 'w');
    return { repo, work, sarif: join(repo, 'h.sarif') };
  };
  // 미끼를 찾으면 이력을 보고 그 종료 코드를 돌려준다. 미끼 폴더는 지운다
  const a = setup();
  const okRun = fakeGitleaks({ historyStatus: 99 });
  assert.equal(runGitleaks({ bin: 'gitleaks', ...a, run: okRun.run }), 99);
  assert.deepEqual(okRun.calls, ['dir', '미끼 꼴 맞음', 'git']);
  assert.equal(existsSync(a.work), false);
  // 미끼마다 값이 달라진다(실행 때 만든다)
  assert.notEqual(decoySecret(), decoySecret());
  // 미끼를 못 찾은 경우: 종료 코드 0, 다른 규칙만 걸림, 보고서 없음, 누출 아닌 오류
  for (const [what, o] of [
    ['종료 코드 0', { decoyStatus: 0 }],
    ['다른 규칙', { decoyRule: 'generic-api-key' }],
    ['보고서 없음', { decoyRule: null }],
    ['오류 종료', { decoyStatus: 1 }],
  ]) {
    const s = setup();
    const f = fakeGitleaks(o);
    assert.throws(() => runGitleaks({ bin: 'gitleaks', ...s, run: f.run }), DecoyError, what);
    assert.equal(f.calls.includes('git'), false, `${what}: 이력을 보지 않는다`);
  }
  // 설정이 기본 규칙을 잇지 않거나 무시 목록이 틀리면 미끼도 돌리지 않고 실패한다
  const c = setup();
  const badConfig = join(c.repo, 'bad.toml');
  writeFileSync(badConfig, '[extend]\nuseDefault = false\n');
  const f1 = fakeGitleaks();
  assert.throws(() => runGitleaks({ bin: 'gitleaks', ...c, config: badConfig, run: f1.run }), /useDefault/);
  assert.deepEqual(f1.calls, []);
  // 저장소 뿌리의 .gitleaksignore(gitleaks가 스스로 읽는 무시 목록)가 있으면 실패한다
  const d = setup();
  writeFileSync(join(d.repo, '.gitleaksignore'), `${'a'.repeat(40)}:x.ts:generic-api-key:1\n`);
  const f2 = fakeGitleaks();
  assert.throws(() => runGitleaks({ bin: 'gitleaks', ...d, run: f2.run }), /\.gitleaksignore/);
  assert.deepEqual(f2.calls, []);
});

test('[ASVS v5.0.0-13.3.1] gitleaks 설정은 기본 규칙을 잇고, 허용 목록마다 까닭이 있으며 모든 파일·폴더 통째를 가리키는 꼴이 없다', () => {
  const real = readFileSync(join(HERE, 'gitleaks.toml'), 'utf8');
  assert.deepEqual(gitleaksConfigProblems(real), []);
  const good = "[extend]\nuseDefault = true\n\n[[allowlists]]\ndescription = '''시험 벡터의 공개 값이라 비밀이 아니다'''\ncondition = 'AND'\npaths = ['''^packages/a/test/v\\.json$''']\nregexes = [\n  '''^[0-9a-f]{64}$''',\n]\n";
  assert.deepEqual(gitleaksConfigProblems(good), []);
  const cases = [
    ['기본 규칙 끔', good.replace('useDefault = true', 'useDefault = false'), /useDefault/],
    ['기본 규칙 없음', good.replace('[extend]\nuseDefault = true\n', ''), /useDefault/],
    ['규칙 끄기', good.replace('useDefault = true', "useDefault = true\ndisabledRules = ['generic-api-key']"), /disabledRules/],
    ['사용자 규칙', `${good}\n[[rules]]\nid = 'x'\n`, /\[\[rules\]\]/],
    ['까닭 없음', good.replace(/description = .*\n/, ''), /까닭/],
    ['까닭 짧음', good.replace(/description = .*\n/, "description = '오탐'\n"), /까닭/],
    ['모든 경로', good.replace('^packages/a/test/v\\.json$', '.*'), /모든 파일/],
    ['모든 경로(^.+$)', good.replace('^packages/a/test/v\\.json$', '^.+$'), /모든 파일/],
    ['모든 값', good.replace('^[0-9a-f]{64}$', '.*'), /모든 글자/],
    ['경로만', good.replace(/regexes = \[\n.*\n\]\n/, ''), /경로만/],
    ['경로와 OR', good.replace("condition = 'AND'\n", ''), /AND/],
    ['커밋 통째', good.replace("condition = 'AND'", "condition = 'AND'\ncommits = ['abc']"), /커밋/],
    ['모르는 키', good.replace("condition = 'AND'", "condition = 'AND'\nregexTargets = 'line'"), /모르는 키/],
  ];
  for (const [what, text, re] of cases) {
    const p = gitleaksConfigProblems(text);
    assert.ok(p.some((m) => re.test(m)), `${what}: ${JSON.stringify(p)}`);
  }
});

test('[ASVS v5.0.0-13.3.1] gitleaks 허용 블록은 targetRules가 있고(경로와 AND면 예외) 값 꼴은 ^…$로 묶으며 넓은 꼴·짧은 stopwords를 받지 않는다(리뷰가 찾은 일곱 꼴과 M25)', () => {
  const base = "[extend]\nuseDefault = true\n\n[[allowlists]]\ndescription = '''오탐을 받는 까닭이 여기에 있다'''\n";
  const ok = `${base}targetRules = ['generic-api-key']\nregexes = ['''^(?:cancel\\-0001|refund\\-0002)$''', '''(?i)^tok_[0-9a-f]{16}$''']\nstopwords = ['notasecret-v1']\n`;
  assert.deepEqual(gitleaksConfigProblems(ok), []);
  const cases = {
    // 리뷰 probe3의 일곱 꼴
    stopword_a: [`${base}targetRules = ['aws-access-token']\nstopwords = ['a']\n`, /stopwords.*8자/],
    stopword_any_rule: [`${base}stopwords = ['e']\n`, /targetRules/],
    regex_w: [`${base}targetRules = ['aws-access-token', 'generic-api-key', 'private-key']\nregexes = ['''\\w''']\n`, /\^…\$/],
    regex_dotq: [`${base}targetRules = ['generic-api-key']\nregexes = ['''.*?''']\n`, /넓은 꼴|\^…\$/],
    regex_class: [`${base}targetRules = ['generic-api-key']\nregexes = ['''[\\s\\S]''']\n`, /넓은 꼴|\^…\$/],
    path_services_and_w: [`${base}condition = 'AND'\npaths = ['''^services/''']\nregexes = ['''[A-Za-z]''']\n`, /\^…\$/],
    regexTarget_line: [`${base}regexTarget = 'line'\ntargetRules = ['aws-access-token']\nregexes = ['''=''']\n`, /\^…\$/],
    // 묶어도 넓은 꼴, (?i)를 떼고 본다(M25), 맨 위 |로 묶음을 빠져나가는 꼴
    anchored_dotstar: [`${base}targetRules = ['generic-api-key']\nregexes = ['''^.*$''']\n`, /넓은 꼴/],
    ci_dotstar_m25: [`${base}targetRules = ['generic-api-key']\nregexes = ['''(?i)^.*$''']\n`, /넓은 꼴/],
    lazy: [`${base}targetRules = ['generic-api-key']\nregexes = ['''^.*?$''']\n`, /넓은 꼴/],
    any_class: [`${base}targetRules = ['generic-api-key']\nregexes = ['''^[\\s\\S]+$''']\n`, /넓은 꼴/],
    not_space: [`${base}targetRules = ['generic-api-key']\nregexes = ['''^\\S+$''']\n`, /넓은 꼴/],
    word: [`${base}targetRules = ['generic-api-key']\nregexes = ['''^tok_\\w+$''']\n`, /넓은 꼴/],
    open_count: [`${base}targetRules = ['generic-api-key']\nregexes = ['''^.{1,}$''']\n`, /넓은 꼴/],
    alternation: [`${base}targetRules = ['generic-api-key']\nregexes = ['''^x|.*$''']\n`, /\|/],
    no_rules_regex: [`${base}regexes = ['''^[0-9a-f]{64}$''']\n`, /targetRules/],
    line_target_wide: [`${base}regexTarget = 'line'\ntargetRules = ['generic-api-key']\nregexes = ['''^.*key.*$''']\n`, /넓은 꼴/],
    // 다시 보기 2: 부정 글자 묶음, 상한 있는 반복, 묶음 안의 .
    neg_space: [`${base}targetRules = ['generic-api-key']\nregexes = ['''^[^\\s]+$''']\n`, /넓은 꼴/],
    class_not_space: [`${base}targetRules = ['generic-api-key']\nregexes = ['''^[\\S]+$''']\n`, /넓은 꼴/],
    bounded_not_space: [`${base}targetRules = ['generic-api-key']\nregexes = ['''^\\S{1,200}$''']\n`, /넓은 꼴/],
    bounded_dot: [`${base}targetRules = ['generic-api-key']\nregexes = ['''^.{0,500}$''']\n`, /넓은 꼴/],
    group_dot: [`${base}targetRules = ['generic-api-key']\nregexes = ['''^(?:.)*$''']\n`, /넓은 꼴/],
    group_dot_newline: [`${base}targetRules = ['generic-api-key']\nregexes = ['''^(.|\\n)*$''']\n`, /넓은 꼴/],
    neg_newline: [`${base}targetRules = ['generic-api-key']\nregexes = ['''^[^\\n]+$''']\n`, /넓은 꼴/],
    bounded_word: [`${base}targetRules = ['generic-api-key']\nregexes = ['''^\\w{1,64}$''']\n`, /넓은 꼴/],
  };
  for (const [what, [text, re]] of Object.entries(cases)) {
    const p = gitleaksConfigProblems(text);
    assert.ok(p.some((m) => re.test(m)), `${what}: ${JSON.stringify(p)}`);
  }
  // 경로와 함께 AND로 좁힌 블록은 targetRules가 없어도 된다(값 꼴은 여전히 묶는다)
  assert.deepEqual(gitleaksConfigProblems(`${base}condition = 'AND'\npaths = ['''^packages/a/test/v\\.json$''']\nregexes = ['''^[0-9a-f]{64}$''']\n`), []);
});

test('[ASVS v5.0.0-13.3.1] 지문 무시 목록의 줄마다 이슈 번호와 교체한 날을 단 주석이 앞에 있다', () => {
  assert.deepEqual(gitleaksIgnoreProblems(readFileSync(join(HERE, 'gitleaks-ignore'), 'utf8')), []);
  const fp = `${'0123456789abcdef'.repeat(2)}01234567:services/a/src/x.ts:generic-api-key:12`;
  assert.deepEqual(gitleaksIgnoreProblems(`# 머리\n\n# #123 2026-11-09 결제사 시험 키를 폐기·재발급했다\n${fp}\n`), []);
  for (const [what, text] of [
    ['주석 없음', `# 머리\n\n${fp}\n`],
    ['날짜 없음', `# #123 결제사 시험 키\n${fp}\n`],
    ['이슈 없음', `# 2026-11-09 결제사 시험 키\n${fp}\n`],
    ['주석이 빈 줄 너머', `# #123 2026-11-09 결제사 시험 키\n\n${fp}\n`],
    ['한 주석에 두 줄', `# #123 2026-11-09 결제사 시험 키\n${fp}\n${fp.replace(':12', ':13')}\n`],
    ['지문 꼴', '# #123 2026-11-09 무엇\nabc:x.ts\n'],
  ]) {
    assert.ok(gitleaksIgnoreProblems(text).length > 0, what);
  }
});

test('[ASVS v5.0.0-13.3.1] 이미지 비밀 검사는 다이제스트 고정 Trivy를 네트워크 없이 secret 검사만, 자료·규칙을 받지 않는 인자로 돌린다', () => {
  const input = join(tempDir('trivy-in-'), 'v0-monolith-amd64.oci.tar');
  const cfg = join(HERE, 'trivy-secret.yaml');
  const args = trivyImageArgs({ input, secretConfig: cfg });
  assert.deepEqual(args, [
    'run', '--rm', '--network', 'none',
    '-v', `${dirname(input)}:/in:ro`,
    '-v', `${cfg}:/cfg/trivy-secret.yaml:ro`,
    TRIVY,
    'image', '--input', '/in/v0-monolith-amd64.oci.tar',
    '--scanners', 'secret',
    '--secret-config', '/cfg/trivy-secret.yaml',
    '--skip-db-update', '--skip-java-db-update', '--offline-scan',
    '--skip-check-update', '--skip-version-check', '--disable-telemetry', '--quiet',
    '--format', 'sarif',
  ]);
  // 기본 비밀 규칙 설정은 tools/ci의 것이다
  assert.ok(trivyImageArgs({ input }).includes(`${cfg}:/cfg/trivy-secret.yaml:ro`));
});

test('[ASVS v5.0.0-13.3.1] Trivy 비밀 규칙 설정은 허용 규칙만 두고 규칙마다 까닭과 좁은 경로·꼴이 있다', { skip: !YAML && 'yaml 패키지가 없다(pnpm install 전)' }, () => {
  const problems = (text) => {
    const doc = YAML.parse(text) ?? {};
    const out = [];
    for (const k of Object.keys(doc)) if (k !== 'allow-rules' && k !== 'disable-allow-rules') out.push(`모르는 키: ${k}`);
    if (!Array.isArray(doc['allow-rules'])) out.push('allow-rules 목록이 없다');
    // Trivy 0.76.1 내장 허용 규칙(pkg/fanal/secret/builtin-allow-rules.go) 13개를 모두 끈다(devops §4.4 '리뷰 뒤 더한 규칙' ④)
    const builtin = ['dist-info', 'tests', 'examples', 'vendor', 'usr-dirs', 'locale-dir', 'markdown', 'node.js', 'golang', 'python', 'rubygems', 'wordpress', 'anaconda-log'];
    const off = doc['disable-allow-rules'] ?? [];
    for (const id of builtin) if (!off.includes(id)) out.push(`내장 허용 규칙을 끄지 않았다: ${id}`);
    for (const r of doc['allow-rules'] ?? []) {
      if (typeof r?.id !== 'string' || r.id === '') out.push('id가 없다');
      if (typeof r?.description !== 'string' || r.description.trim().length < 10) out.push(`${r?.id}: 까닭이 없다`);
      if (!r?.path && !r?.regex) out.push(`${r?.id}: 경로·꼴이 없다`);
      for (const p of [r?.path, r?.regex].filter(Boolean)) if (/^\^?\.?[*+]?\$?$|^\^?\.\*\$?$/.test(p)) out.push(`${r?.id}: ${p}는 모두를 가리킨다`);
    }
    return out;
  };
  assert.deepEqual(problems(readFileSync(join(HERE, 'trivy-secret.yaml'), 'utf8')), []);
  assert.ok(problems('allow-rules: []\n').some((m) => m.includes('usr-dirs')), '내장 허용 규칙을 켜 둔 설정');
  assert.ok(problems(`disable-allow-rules: [${TRIVY_BUILTIN_ALLOW_RULES.filter((id) => id !== 'tests').join(', ')}]\nallow-rules: []\n`).some((m) => m.includes('tests')), '하나 빠짐');
  assert.ok(problems('disable-rules: [aws-access-key-id]\nallow-rules: []\n').some((m) => m.includes('disable-rules')), '규칙 끄기');
  assert.ok(problems('enable-builtin-rules: [github-pat]\nallow-rules: []\n').length > 0, '내장 규칙 고르기');
  assert.ok(problems('allow-rules:\n  - id: x\n    path: .*\n    description: 모든 파일을 허용하는 잘못된 규칙\n').length > 0, '모든 경로');
  assert.ok(problems('allow-rules:\n  - id: x\n    path: ^usr/lib/node_modules/a/test\n').length > 0, '까닭 없음');
});

test('trivy-config는 다이제스트 고정 이미지를 네트워크 없이 읽기 전용으로 띄우고 --skip-check-update로 정본의 대상만 본다(deploy/local·tools·loadtest 뺌)', () => {
  // 정본의 대상(ADR-0263 결정 7): infra/, deploy/(deploy/local 뺌), 운영 이미지 Dockerfile(services/, packages/platform/template)
  assert.deepEqual(
    IAC_TARGETS.map((t) => [t.path, t.skipDirs ?? [], t.scanners ?? null]),
    [
      ['infra', [], null],
      ['deploy', ['deploy/local'], null],
      ['services', [], ['dockerfile']],
      ['packages/platform/template', [], ['dockerfile']],
      ['deploy/charts', [], null],
    ],
  );
  assert.deepEqual(IAC_TARGETS.find((t) => t.path === 'deploy/charts').helmValues, ['tools/ci/trivy-chart-values.yaml']);
  assert.equal(IAC_TARGETS.some((t) => /^(tools|loadtest)(\/|$)/.test(t.path) || t.path === '.' || t.path === 'packages/platform'), false);
  assert.deepEqual(new Set(IAC_TARGETS.map((t) => t.name)).size, IAC_TARGETS.length, '대상 이름(결과 파일 이름)이 겹치지 않는다');
  const repo = tempDir('trivy-repo-');
  const deploy = IAC_TARGETS.find((t) => t.path === 'deploy');
  assert.deepEqual(trivyConfigArgs({ repo, target: deploy }), [
    'run', '--rm', '--network', 'none', '-v', `${repo}:/src:ro`, TRIVY,
    'config', '--skip-check-update', '--skip-version-check', '--disable-telemetry', '--quiet', '--format', 'sarif',
    '--skip-dirs', '**/node_modules',
    '--skip-dirs', '/src/deploy/local',
    '--helm-values', '/src/deploy/envs/local/v0-monolith.yaml',
    '/src/deploy',
  ]);
  for (const t of IAC_TARGETS) {
    const a = trivyConfigArgs({ repo, target: t });
    assert.equal(a.at(-1), `/src/${t.path}`);
    assert.ok(a.includes(`${repo}:/src:ro`) && a.includes('--skip-check-update') && a.join(' ').includes('--network none'), t.path);
    // 차트 값 파일은 저장소에 있어야 한다(없으면 차트를 건너뛴다)
    for (const v of t.helmValues ?? []) assert.ok(existsSync(join(HERE, '..', '..', v)), v);
  }
  // 대상이 없거나 빈 폴더(붙이는 자리가 틀림)면 결과 없이 통과하지 않게 먼저 막는다. 저장소에는 다 있다
  assert.deepEqual(missingIacTargets(join(HERE, '..', '..')), []);
  const empty = tempDir('trivy-empty-');
  const missing = missingIacTargets(empty);
  assert.equal(missing.length, IAC_TARGETS.length + 2, JSON.stringify(missing));
  assert.ok(missing.some((m) => m.includes('deploy/envs/local/v0-monolith.yaml')));
  assert.ok(missing.every((m) => !m.includes('비었다')));
  // 빈 폴더 분기: 대상 폴더는 있는데 비면 막는다(M24 뒤 독립 검사가 짚은 분기)
  const partial = tempDir('trivy-partial-');
  for (const t of IAC_TARGETS) mkdirSync(join(partial, t.path), { recursive: true });
  for (const t of IAC_TARGETS.filter((x) => x.path !== 'infra')) writeFileSync(join(partial, t.path, 'x.txt'), 'x');
  for (const v of IAC_TARGETS.flatMap((t) => t.helmValues ?? [])) {
    mkdirSync(dirname(join(partial, v)), { recursive: true });
    writeFileSync(join(partial, v), 'name: x\n');
  }
  assert.deepEqual(missingIacTargets(partial), ['설정 검사 대상 폴더가 비었다: infra']);
});

test('저장소 파일에 이 도구가 만드는 미끼나 비밀 꼴 글자가 남지 않는다', () => {
  // 미끼는 실행 때만 만들고 지운다. 시험·설정 파일에 GitHub 토큰 꼴 글자가 없다
  const token = new RegExp(`${'gh'}${'p_'}[0-9A-Za-z]{36}`);
  for (const f of ['scan-tools.mjs', 'scan-tools.test.mjs', 'scan-gate.mjs', 'scan-gate.test.mjs', 'gitleaks.toml', 'gitleaks-ignore', 'trivy-secret.yaml']) {
    assert.equal(token.test(readFileSync(join(HERE, f), 'utf8')), false, f);
  }
});

// ---------- 리뷰 뒤 더한 규칙 ③④(docs/devops.md §4.4, ADR-0263 결정 13) ----------

test('IaC 대상 안의 Trivy 줄 안 무시 주석(trivy:ignore·tfsec:ignore)을 찾아 설정 검사를 막는다(대상 밖·deploy/local·Dockerfile 아닌 서비스 파일은 보지 않는다)', () => {
  const repo = tempDir('trivy-ignore-');
  const put = (p, text) => {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), text);
  };
  put('infra/stacks/a/main.tf', 'resource "x" "y" {\n  #trivy:ignore:GIT-0001\n  visibility = "public"\n}\n');
  put('deploy/charts/c/templates/d.yaml', 'kind: Deployment\n# tfsec:ignore:KSV-0014\n');
  put('services/a-svc/Dockerfile', 'FROM scratch\n# trivy:ignore:DS-0002\n');
  put('packages/platform/template/Dockerfile', 'FROM scratch\nUSER node\n');
  // 보지 않는 곳: Dockerfile만 보는 대상의 다른 파일, deploy/local, node_modules, 대상 밖
  put('services/a-svc/src/notes.ts', '// trivy:ignore:DS-0002 설명 글\n');
  put('deploy/local/kind.yaml', '# trivy:ignore:KSV-0001\n');
  put('infra/node_modules/x/main.tf', '#trivy:ignore:GIT-0001\n');
  put('tools/ci/x.mjs', '// trivy:ignore\n');
  put('tools/ci/trivy-chart-values.yaml', 'name: x # tfsec:ignore:KSV-0001\n');
  assert.deepEqual(findInlineIgnores(repo), [
    'deploy/charts/c/templates/d.yaml:2',
    'infra/stacks/a/main.tf:2',
    'services/a-svc/Dockerfile:2',
    'tools/ci/trivy-chart-values.yaml:1',
  ]);
  // 저장소에는 없다
  assert.deepEqual(findInlineIgnores(join(HERE, '..', '..')), []);
});

/** Trivy 설정 검사 SARIF 한 벌(대상 폴더 기준 경로와 규칙 등급) */
const trivySarif = (dir, results) =>
  JSON.stringify({
    runs: [
      {
        tool: { driver: { name: 'Trivy', rules: [...new Set(results.map(([id, , sev]) => `${id}|${sev}`))].map((k) => ({ id: k.split('|')[0], properties: { 'security-severity': k.split('|')[1] } })) } },
        results: results.map(([id, uri]) => ({ ruleId: id, locations: [{ physicalLocation: { artifactLocation: { uri, uriBaseId: 'ROOTPATH' }, region: { startLine: 1 } } }] })),
        originalUriBaseIds: { ROOTPATH: { uri: `file:///src/${dir}/` } },
      },
    ],
  });

test('Trivy 설정 검사는 미끼(높음이 나와야 할 Dockerfile·Terraform)를 같은 인자로 먼저 돌려 높음이 없으면 대상을 보지 않고 실패한다', () => {
  // 미끼 판정: 미끼 파일마다 등급 7.0 이상 결과가 하나라도 있어야 한다
  const all3 = [['DS-0002', 'Dockerfile', '8.0'], ['GIT-0001', 'main.tf', '9.5'], ['KSV-0017', 'chart/templates/pod.yaml', '8.0']];
  assert.deepEqual(configDecoyProblems(trivySarif('decoy', all3)), []);
  assert.ok(configDecoyProblems(trivySarif('decoy', all3.filter(([, f]) => f !== 'main.tf'))).some((m) => m.includes('main.tf')));
  assert.ok(configDecoyProblems(trivySarif('decoy', [['DS-0026', 'Dockerfile', '2.0'], ['GIT-0001', 'main.tf', '6.9'], ['KSV-0017', 'chart/templates/pod.yaml', '8.0']])).length === 2);
  // 차트를 그리지 못하면(값 파일을 못 읽음, required·fail) Trivy는 차트를 건너뛰고 결과 없이 끝난다. 그때 막는다(다시 보기 1)
  assert.ok(configDecoyProblems(trivySarif('decoy', all3.slice(0, 2))).some((m) => m.includes('chart/templates/pod.yaml')));
  // 미끼 차트는 값 파일이 있어야만 그려지고(required), 그 값이 권한 상승 컨테이너를 켠다
  assert.match(CONFIG_DECOY.files['chart/templates/pod.yaml'], /required /);
  assert.match(CONFIG_DECOY.files['chart/templates/pod.yaml'], /privileged/);
  assert.match(CONFIG_DECOY.files['chart-values.yaml'], /privileged: true/);
  assert.deepEqual(CONFIG_DECOY.target.helmValues, ['decoy/chart-values.yaml']);
  assert.ok(configDecoyProblems('').length > 0);
  // 실행: 미끼가 먼저 돌고 같은 인자(이미지·네트워크 없음·읽기 전용·--skip-check-update)를 쓴다. 높음이 없으면 대상은 돌지 않는다
  const repo = join(HERE, '..', '..');
  for (const [what, decoyOut, expectTargets] of [
    ['미끼 찾음', trivySarif('decoy', [['DS-0002', 'Dockerfile', '8.0'], ['GIT-0001', 'main.tf', '9.5'], ['KSV-0017', 'chart/templates/pod.yaml', '8.0']]), true],
    ['미끼 못 찾음', trivySarif('decoy', [['DS-0026', 'Dockerfile', '2.0']]), false],
  ]) {
    const calls = [];
    const docker = (args) => {
      calls.push(args);
      return Buffer.from(args.at(-1) === '/src/decoy' ? decoyOut : trivySarif('x', []));
    };
    const out = join(tempDir('trivy-run-'), 'out');
    if (expectTargets) {
      runTrivyConfig({ repo, out, docker });
      assert.equal(calls.length, IAC_TARGETS.length + 1, what);
      assert.deepEqual(readdirSync(out).sort(), IAC_TARGETS.map((t) => `${t.name}.sarif`).sort(), '미끼 결과는 판정 폴더에 두지 않는다');
    } else {
      assert.throws(() => runTrivyConfig({ repo, out, docker }), DecoyError, what);
      assert.equal(calls.length, 1, `${what}: 대상을 보지 않는다`);
    }
    const [decoy] = calls;
    assert.equal(decoy.at(-1), '/src/decoy');
    for (const a of ['--network', 'none', TRIVY, 'config', '--skip-check-update', '--format', 'sarif', '--helm-values', '/src/decoy/chart-values.yaml']) assert.ok(decoy.includes(a), a);
    assert.ok(decoy.some((a) => a.endsWith(':/src:ro')));
  }
});

test('[ASVS v5.0.0-13.3.1] 이미지 비밀 검사는 실행 때 조립한 가짜 비밀을 담은 작은 이미지 묶음을 같은 설정으로 먼저 검사해 못 찾으면 실제 묶음을 보지 않고 실패한다', () => {
  const dir = tempDir('trivy-image-decoy-');
  const tar = writeImageDecoy(dir);
  // docker save 꼴 묶음: manifest.json → 설정·층. 층 안에 가짜 비밀 파일이 있고, 저장소에는 그 글자가 없다(실행 때 조립)
  const bytes = readFileSync(tar);
  const manifest = JSON.parse(extractTarMember(bytes, 'manifest.json').toString('utf8'));
  assert.equal(manifest.length, 1);
  const layer = extractTarMember(bytes, manifest[0].Layers[0]);
  const config = JSON.parse(extractTarMember(bytes, manifest[0].Config).toString('utf8'));
  assert.deepEqual(config.rootfs.diff_ids, [`sha256:${hash(layer)}`]);
  const secretFile = extractTarMember(layer, 'srv/decoy/settings.env').toString('utf8');
  // 내장 허용 규칙(usr-dirs·tests)이 건너뛰는 자리 아래의 가짜 비밀: 그 규칙을 끈 설정이어야 찾는다(다시 보기 6)
  assert.match(extractTarMember(layer, 'usr/lib/peaket-decoy/test/token.env').toString('utf8'), new RegExp(`${'gh'}${'p_'}[0-9A-Za-z]{36}`));
  assert.match(secretFile, new RegExp(`${'AK'}${'IA'}[A-Z2-7]{16}`));
  assert.match(secretFile, new RegExp(`${'gh'}${'p_'}[0-9A-Za-z]{36}`));
  assert.equal(tar, join(dir, 'decoy.tar'));
  // 미끼 판정: 두 내장 규칙(AWS 접근 키 ID, GitHub 개인 토큰)이 모두 걸려야 한다
  const at = (id, uri) => ({ ruleId: id, locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: 1 } } }] });
  const found = (ids, extra = [at('github-pat', '/usr/lib/peaket-decoy/test/token.env')]) =>
    JSON.stringify({ runs: [{ tool: { driver: { name: 'Trivy' } }, results: [...ids.map((id) => at(id, '/srv/decoy/settings.env')), ...extra] }] });
  assert.deepEqual(imageDecoyProblems(found(['aws-access-key-id', 'github-pat'])), []);
  assert.ok(imageDecoyProblems(found(['aws-access-key-id'], [])).some((m) => m.includes('github-pat')));
  assert.ok(imageDecoyProblems(found([], [])).length === 3);
  // 허용 경로 아래 미끼를 못 찾으면(내장 허용 규칙이 켜져 있으면) 막는다
  assert.ok(imageDecoyProblems(found(['aws-access-key-id', 'github-pat'], [])).some((m) => m.includes('usr/lib/peaket-decoy/test')));
  assert.ok(imageDecoyProblems('{').length > 0);
  // 실행: 미끼를 같은 설정(--secret-config, 네트워크 없음)으로 먼저 보고, 못 찾으면 실제 묶음은 보지 않는다
  for (const [what, decoyIds, ok] of [
    ['찾음', ['aws-access-key-id', 'github-pat'], true],
    ['못 찾음', [], false],
  ]) {
    const calls = [];
    const docker = (args) => {
      calls.push(args);
      return Buffer.from(args.includes('/in/decoy.tar') ? found(decoyIds) : found([]));
    };
    const work = tempDir('trivy-image-work-');
    const input = join(work, 'v0-monolith-amd64.oci.tar');
    writeFileSync(input, 'oci');
    const sarif = join(work, 'out', 'image.sarif');
    if (ok) {
      runTrivyImage({ input, sarif, work: join(work, 'decoy'), docker });
      assert.equal(calls.length, 2);
      assert.ok(calls[1].includes('/in/v0-monolith-amd64.oci.tar'));
      assert.ok(existsSync(sarif));
    } else {
      assert.throws(() => runTrivyImage({ input, sarif, work: join(work, 'decoy'), docker }), DecoyError, what);
      assert.equal(calls.length, 1);
      assert.equal(existsSync(sarif), false);
    }
    for (const a of ['--network', 'none', TRIVY, '--scanners', 'secret', '--secret-config', '/cfg/trivy-secret.yaml', '--skip-db-update', '--offline-scan']) assert.ok(calls[0].includes(a), `${what} ${a}`);
  }
});

/**
 * 차트 도우미 peaket.leaderLeases와 같은 계산: service.leaderLease가 비지 않은 글이면 [글], 목록이면 그 목록, 그 밖(빈 글·없음)은 [](_helpers.tpl,
 * 갈래 1 PRF-215가 글·목록 둘 다 받게 바꿨다). 템플릿의 $leases := include "peaket.leaderLeases" . | fromJsonArray를 이것으로 푼다
 */
function leaderLeases(values) {
  const raw = values?.service?.leaderLease;
  if (typeof raw === 'string') return raw === '' ? [] : [raw];
  return Array.isArray(raw) ? raw : [];
}

/** Go 템플릿의 맨 위 if 조건(and·or·not·.Values 경로·$변수)을 값으로 계산한다 */
function templateCondition(text, values) {
  const lines = text.split(/\r?\n/);
  const vars = {};
  const get = (path) => {
    const [head, ...rest] = path.split('.');
    let v = head === '' ? { Values: values } : vars[head.replace(/^\$/, '')];
    for (const k of head === '' ? rest : rest) v = v?.[k];
    return v;
  };
  const truthy = (v) => !(v === undefined || v === null || v === false || v === 0 || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && v !== null && Object.keys(v).length === 0));
  const evalExpr = (src) => {
    const tokens = src.match(/\(|\)|[^\s()]+/g);
    let i = 0;
    const term = () => {
      const t = tokens[i++];
      if (t === '(') {
        const v = call();
        i++;
        return v;
      }
      if (t === 'and' || t === 'or' || t === 'not') {
        i--;
        return call();
      }
      return get(t);
    };
    const call = () => {
      const t = tokens[i];
      if (t === 'and' || t === 'or' || t === 'not') {
        i++;
        const args = [];
        while (i < tokens.length && tokens[i] !== ')') args.push(term());
        if (t === 'not') return !truthy(args[0]);
        return t === 'and' ? args.every(truthy) : args.some(truthy);
      }
      return term();
    };
    return call();
  };
  for (const l of lines) {
    const a = /^\{\{-?\s*(\$\w+)\s*:=\s*(.+?)\s*-?\}\}/.exec(l);
    if (a && /^include\s+"peaket\.leaderLeases"\s+\.\s*\|\s*fromJsonArray$/.test(a[2])) vars[a[1].slice(1)] = leaderLeases(values);
    else if (a && !/\|/.test(a[2])) vars[a[1].slice(1)] = evalExpr(a[2]);
    const m = /^\{\{-?\s*if\s+(.+?)\s*-?\}\}/.exec(l);
    if (m) return truthy(evalExpr(m[1]));
  }
  return null;
}

test('공용 차트는 모든 템플릿 맨 위 if 조건을 켜는 CI 값 파일로도 그린다(템플릿마다 켜진다)', { skip: !YAML && 'yaml 패키지가 없다(pnpm install 전)' }, () => {
  const ROOT = join(HERE, '..', '..');
  const chart = join(ROOT, 'deploy', 'charts', 'peaket-service');
  const merge = (a, b) => {
    if (b === undefined) return a;
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) return Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, merge(a[k], b[k])]));
    return b;
  };
  const defaults = YAML.parse(readFileSync(join(chart, 'values.yaml'), 'utf8'));
  const ci = YAML.parse(readFileSync(join(ROOT, 'tools', 'ci', 'trivy-chart-values.yaml'), 'utf8'));
  const values = merge(defaults, ci);
  const templates = readdirSync(join(chart, 'templates')).filter((f) => f.endsWith('.yaml'));
  assert.ok(templates.length >= 5, templates.join(','));
  for (const f of templates) {
    const text = readFileSync(join(chart, 'templates', f), 'utf8');
    assert.equal(templateCondition(text, values), true, `${f}: CI 값으로 켜지지 않는다`);
    // 같은 계산이 기본값에서는 꺼지는 템플릿이 있다(계산이 늘 참은 아니다)
  }
  assert.ok(templates.some((f) => templateCondition(readFileSync(join(chart, 'templates', f), 'utf8'), defaults) === false), '기본값으로 꺼지는 템플릿이 하나도 없으면 계산을 의심한다');
  // Lease 템플릿은 service.leaderLease(글이나 목록)에서 온 $leases로 켜진다: 기본값(빈 글)이면 꺼지고 글·목록이면 켜진다
  const lease = readFileSync(join(chart, 'templates', 'leader-lease.yaml'), 'utf8');
  assert.equal(templateCondition(lease, defaults), false);
  assert.equal(templateCondition(lease, merge(defaults, { service: { leaderLease: 'a-leader' } })), true);
  assert.equal(templateCondition(lease, merge(defaults, { service: { leaderLease: ['a-leader', 'b-leader'] } })), true);
  assert.equal(templateCondition(lease, merge(defaults, { service: { leaderLease: [] } })), false);
  // 새로 생긴 갈래(추가 포트·볼륨·붙일 자리, 릴레이 볼륨)도 CI 값이 채워 Trivy가 그 부분까지 그린다
  for (const [what, v] of [
    ['service.extraPorts', values.service.extraPorts],
    ['service.volumes', values.service.volumes],
    ['service.volumeMounts', values.service.volumeMounts],
    ['outboxRelay.volumes', values.outboxRelay.volumes],
    ['outboxRelay.volumeMounts', values.outboxRelay.volumeMounts],
  ]) {
    assert.ok(Array.isArray(v) && v.length > 0, `${what}를 CI 값이 채우지 않는다`);
  }
  // 차트가 필수로 묻는 값(이름·이미지 다이제스트·환경)을 채운다
  assert.match(values.image.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(typeof values.name, 'string');
  assert.ok(values.name.length > 0);
});

test('공용 차트의 CI 값 파일은 템플릿의 required 값을 모두 채우고 fail 조건에 걸리지 않는다(다시 보기 1)', { skip: !YAML && 'yaml 패키지가 없다(pnpm install 전)' }, () => {
  const ROOT = join(HERE, '..', '..');
  const chart = join(ROOT, 'deploy', 'charts', 'peaket-service');
  const merge = (a, b) => {
    if (b === undefined) return a;
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) return Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, merge(a[k], b[k])]));
    return b;
  };
  const values = merge(YAML.parse(readFileSync(join(chart, 'values.yaml'), 'utf8')), YAML.parse(readFileSync(join(ROOT, 'tools', 'ci', 'trivy-chart-values.yaml'), 'utf8')));
  const files = readdirSync(join(chart, 'templates')).map((f) => [f, readFileSync(join(chart, 'templates', f), 'utf8')]);
  // required: 모든 required "…" <경로>가 CI 값으로 채워진다($변수는 같은 파일의 := 정의로 푼다)
  let required = 0;
  for (const [f, text] of files) {
    const vars = Object.fromEntries([...text.matchAll(/\$(\w+)\s*:=\s*(\.Values[\w.]*)/g)].map((m) => [m[1], m[2]]));
    for (const m of text.matchAll(/required\s+"[^"]*"\s+(\.Values[\w.]+|\$\w+[\w.]*)/g)) {
      required++;
      const path = m[1].startsWith('$') ? m[1].replace(/^\$(\w+)/, (_, v) => vars[v] ?? `$${v}`) : m[1];
      assert.ok(path.startsWith('.Values.'), `${f}: ${m[1]}를 풀지 못했다`);
      const v = path.slice('.Values.'.length).split('.').reduce((o, k) => o?.[k], values);
      assert.ok(v !== undefined && v !== null && v !== '', `${f}: required ${path}를 CI 값이 채우지 않는다`);
    }
  }
  assert.ok(required >= 3, `required ${required}개`);
  // fail: 차트의 fail 조건마다 CI 값이 걸리지 않는지 본다. 새 fail이 생기면 이 목록도 고친다(센 수가 다르면 실패)
  const failCount = files.reduce((n, [, t]) => n + (t.match(/\bfail\s+(?:"|\(printf)/g) ?? []).length, 0);
  const a = values.service.autoscaling;
  const np = values.service.networkPolicy;
  const internal = np.egress?.internal ?? [];
  const checks = {
    'image.digest 꼴': /^sha256:[0-9a-f]{64}$/.test(values.image.digest),
    'autoscaling.minReplicas >= 1': a.minReplicas >= 1,
    'autoscaling.maxReplicas >= minReplicas': a.maxReplicas >= a.minReplicas,
    'autoscaling.targetCPUUtilizationPercentage 1~100': a.targetCPUUtilizationPercentage >= 1 && a.targetCPUUtilizationPercentage <= 100,
    'autoscaling은 requests.cpu가 있다': Boolean(values.service.resources?.requests?.cpu),
    'egress.internal 칸마다 ports': internal.every((x) => Array.isArray(x.ports) && x.ports.length > 0),
    'egress.internal 칸마다 대상': internal.every((x) => x.cidrs || x.allowLinkLocalCidrs || x.namespaces || x.podLabels),
    'cidrs와 namespaces·podLabels를 섞지 않음': internal.every((x) => !(x.cidrs && (x.namespaces || x.podLabels))),
    'allowLinkLocalCidrs를 섞지 않음': internal.every((x) => !(x.allowLinkLocalCidrs && (x.cidrs || x.namespaces || x.podLabels))),
    'cidrs 꼴·길이·링크 로컬 아님': internal.flatMap((x) => x.cidrs ?? []).every((c) => /^[0-9a-fA-F:.]+\/[0-9]+$/.test(c) && Number(c.split('/')[1]) >= 8 && !/^0*169\./.test(c)),
    'PEAKET_ENV가 있다(태그 이미지가 아니면 쓰지 않지만 채운다)': Boolean(values.env.PEAKET_ENV),
    'PEAKET_ENV는 local·ci(태그 갈래의 fail)': ['local', 'ci'].includes(values.env.PEAKET_ENV),
    // peaket.leaderLeases: 글이나 목록, 이름마다 DNS-1123, 겹치지 않음
    'leaderLease는 글이나 글 목록': typeof values.service.leaderLease === 'string' || (Array.isArray(values.service.leaderLease) && values.service.leaderLease.every((x) => typeof x === 'string')),
    'leaderLease 이름은 DNS-1123': leaderLeases(values).every((x) => /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(x)),
    'leaderLease 이름이 겹치지 않음': new Set(leaderLeases(values)).size === leaderLeases(values).length,
    // peaket.volumes(service·outboxRelay): 칸마다 name과 종류 하나, 종류는 secret·configMap·emptyDir(hostPath는 local·ci만)
    '볼륨 칸마다 name과 종류 하나(받는 종류)': [...(values.service.volumes ?? []), ...(values.outboxRelay.volumes ?? [])].every((v) => {
      const kinds = Object.keys(v ?? {}).filter((k) => k !== 'name');
      return v && typeof v === 'object' && v.name && kinds.length === 1 && (['secret', 'configMap', 'emptyDir'].includes(kinds[0]) || (kinds[0] === 'hostPath' && ['local', 'ci'].includes(values.env.PEAKET_ENV)));
    }),
    // peaket.extraPorts: name은 소문자·숫자·- 15자 안, port 1~65535, 앱·관리 포트·서로와 겹치지 않음
    '추가 포트 name 꼴': (values.service.extraPorts ?? []).every((p) => /^[a-z]([-a-z0-9]{0,13}[a-z0-9])?$/.test(String(p.name))),
    '추가 포트 port 1~65535': (values.service.extraPorts ?? []).every((p) => Number(p.port) >= 1 && Number(p.port) <= 65535),
    '추가 포트가 앱·관리 포트·서로와 겹치지 않음': (() => {
      const ports = [values.service.port, values.managementPort, ...(values.service.extraPorts ?? []).map((p) => p.port)].map(Number);
      const names = ['http', 'management', ...(values.service.extraPorts ?? []).map((p) => String(p.name))];
      return new Set(ports).size === ports.length && new Set(names).size === names.length;
    })(),
  };
  for (const [what, ok] of Object.entries(checks)) assert.equal(ok, true, what);
  // 지금 차트의 fail 수(값 꼴·태그 환경·HPA 넷·이그레스 칸, 갈래 1 PRF-215가 더한 Lease 이름·볼륨·추가 포트 검사). 늘면 위 목록에 그 조건을 더한다
  assert.equal(failCount, 30, `fail ${failCount}개`);
});
