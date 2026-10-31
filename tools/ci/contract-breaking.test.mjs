// 계약 깨짐 검사(docs/api/guidelines.md §1, docs/devops.md §3.1 contract-check, D-T48·D-T38, openspec 변경 add-contract-breaking-check)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commit, git, repo, tempDir } from './git-fixture.mjs';
import { checkContracts, chooseBases, IMAGES, parseIgnore, parseOverrides, serviceTargets } from './contract-breaking.mjs';

const OPENAPI = 'openapi: 3.1.0\ninfo: { title: t, version: "1" }\npaths: {}\n';
const ASYNCAPI = 'asyncapi: 3.0.0\ninfo: { title: t, version: "1" }\ncomponents: { messages: { M: { payload: { type: object, properties: { x: { type: string } } } } } }\n';
const BREAKING = {
  'docs/api/breaking/openapi-levels.txt': '# 정본 근거: guidelines §1 응답 필드 지우기\nresponse-optional-property-removed ERR  # 끝 주석\n\n',
  'docs/api/breaking/asyncapi-levels.txt': 'response-optional-property-removed ERR\n',
  'docs/api/breaking/asyncapi-avro-levels.txt': 'response-optional-property-removed ERR\nresponse-property-enum-value-added WARN\n',
  'docs/api/breaking/openapi-ignore.txt': '# 예외 없음\n',
  'docs/api/breaking/asyncapi-ignore.txt': '',
  'docs/api/breaking/asyncapi-overrides.json': '{}\n',
};
const base = { 'docs/api/openapi.yaml': OPENAPI, 'docs/api/asyncapi.yaml': ASYNCAPI, ...BREAKING };

// 도구 실행과 메시지 본문 변환(packages/contracts/scripts/asyncapi-messages.mjs)을 바꿔 끼운다.
// 도구는 부른 인자와 /w/ 아래 파일 내용을 적고, `<도구>:<첫 인자>:<그 도구·인자로 몇 번째>`에 정한 결과를 돌려준다
function fake(results = {}) {
  const calls = [];
  const converted = [];
  const run = async (tool, args, dir) => {
    const files = Object.fromEntries(args.filter((a) => a.startsWith('/w/')).map((a) => [a, readFileSync(join(dir, a.slice(3)), 'utf8')]));
    calls.push({ tool, args, files });
    const nth = calls.filter((c) => c.tool === tool && c.args[0] === args[0]).length;
    return results[`${tool}:${args[0]}:${nth}`] ?? { code: 0, out: '' };
  };
  const convert = (from, to, kind) => {
    converted.push({ text: readFileSync(from, 'utf8'), kind });
    writeFileSync(to, JSON.stringify({ openapi: '3.1.0', info: { title: 't', version: '1' }, paths: { [`/messages/M-${kind}`]: {} } }));
  };
  return { run, convert, calls, converted };
}

const check = (cwd, f, extra = {}) => checkContracts({ cwd, target: 'develop', labels: [], pullRequest: true, run: f.run, convert: f.convert, ...extra });

function project() {
  const dir = repo('contract-breaking-');
  commit(dir, base, 'chore: 계약');
  git(dir, 'branch', 'develop');
  return dir;
}

test('DT48_대상가지와_마지막출시태그_둘다와견준다', () => {
  const dir = project();
  git(dir, 'tag', 'v0.1.0');
  commit(dir, { 'docs/api/openapi.yaml': OPENAPI + '# 판 2\n' }, 'feat: 판 2');
  git(dir, 'tag', 'v0.2.0');
  git(dir, 'tag', 'v0.10.0-rc.1'); // 출시 태그가 아니다
  commit(dir, { 'a.txt': '1' }, 'chore: 대상 가지 앞으로');
  git(dir, 'branch', '-f', 'develop');
  const { bases, notes } = chooseBases({ cwd: dir, target: 'develop' });
  assert.deepEqual(bases.map((b) => b.label), ['대상 가지 develop', '마지막 출시 태그 v0.2.0']);
  assert.deepEqual(notes, []);
});

test('DT48_두기준이같은커밋이면_한번만보고_출시태그가없으면_까닭을적는다', () => {
  const dir = project();
  git(dir, 'tag', 'v1.0.0');
  assert.deepEqual(chooseBases({ cwd: dir, target: 'develop' }).bases.map((b) => b.label), ['대상 가지 develop']);
  const none = project();
  const r = chooseBases({ cwd: none, target: 'develop' });
  assert.equal(r.bases.length, 1);
  assert.match(r.notes.join('\n'), /출시 태그가 없어/);
  assert.throws(() => chooseBases({ cwd: none, target: 'origin/nope' }), /대상 가지 origin\/nope/);
});

test('DT48_oasdiff를_정본기준으로부르고_ERR이면실패한다', async () => {
  const dir = project();
  const f = fake({ 'oasdiff:breaking:1': { code: 1, out: '1 changes: 1 error, 0 warning, 0 info\nerror\t[response-optional-property-removed]' } });
  const r = await check(dir, f);
  const rest = f.calls.find((c) => c.tool === 'oasdiff' && '/w/new.openapi.yaml' in c.files);
  assert.deepEqual(rest.args.slice(0, 3), ['breaking', '/w/base.openapi.yaml', '/w/new.openapi.yaml']);
  for (const flag of ['--fail-on', 'ERR', '--severity-levels', '/w/openapi-levels.txt', '--err-ignore', '/w/openapi-ignore.txt']) assert.ok(rest.args.includes(flag), flag);
  // oasdiff 수준 파일은 주석을 받지 않으므로(1.34.1, 종료 코드 106) 주석과 빈 줄을 지운 사본을 넘긴다
  assert.equal(rest.files['/w/openapi-levels.txt'], 'response-optional-property-removed ERR\n');
  assert.equal(rest.files['/w/base.openapi.yaml'], OPENAPI);
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0], /OpenAPI.*대상 가지 develop/);
  assert.match(r.failures[0], /response-optional-property-removed/);
});

test('DT48_WARN만있으면_통과하고_경고로남긴다', async () => {
  const dir = project();
  const f = fake({ 'oasdiff:breaking:1': { code: 0, out: '1 changes: 0 error, 1 warning, 0 info\nwarning\t[request-property-removed]' } });
  const r = await check(dir, f);
  assert.deepEqual(r.failures, []);
  assert.match(r.warnings.join('\n'), /request-property-removed/);
});

test('DT48_AsyncAPI는_채널수준asyncapi diff와_본문oasdiff_둘다본다', async () => {
  const dir = project();
  const f = fake({ 'asyncapi:diff:1': { code: 1, out: 'breaking remove /channels/b' }, 'oasdiff:breaking:2': { code: 1, out: 'error\t[response-property-enum-value-removed]' } });
  const r = await check(dir, f);
  const diff = f.calls.find((c) => c.tool === 'asyncapi');
  assert.deepEqual(diff.args.slice(0, 5), ['diff', '/w/base.asyncapi.yaml', '/w/new.asyncapi.yaml', '-t', 'breaking']);
  assert.ok(diff.args.includes('--overrides'));
  // 메시지 본문은 내용 형식별로 나눠 견준다: JSON 메시지는 열거 값 더하기도 ERR(생성 Zod가 거절), Avro 메시지는 WARN(UNRECOGNIZED 규칙)
  const [, json, avro] = f.calls.filter((c) => c.tool === 'oasdiff');
  assert.deepEqual(json.args.slice(1, 3), ['/w/base.asyncapi.json-messages.json', '/w/new.asyncapi.json-messages.json']);
  assert.ok(json.args.includes('/w/asyncapi-levels.txt') && json.args.includes('/w/asyncapi-ignore.txt'));
  assert.ok(JSON.parse(json.files['/w/new.asyncapi.json-messages.json']).paths['/messages/M-json']);
  assert.deepEqual(avro.args.slice(1, 3), ['/w/base.asyncapi.avro-messages.json', '/w/new.asyncapi.avro-messages.json']);
  assert.ok(avro.args.includes('/w/asyncapi-avro-levels.txt') && avro.args.includes('/w/asyncapi-ignore.txt'));
  assert.deepEqual(f.converted, [
    { text: ASYNCAPI, kind: 'json' }, { text: ASYNCAPI, kind: 'json' }, { text: ASYNCAPI, kind: 'avro' }, { text: ASYNCAPI, kind: 'avro' },
  ]);
  assert.equal(r.failures.length, 2);
  assert.match(r.failures.join('\n'), /AsyncAPI 채널·작업/);
  assert.match(r.failures.join('\n'), /AsyncAPI 메시지 본문\(JSON\)/);
});

test('DT48_기준에계약파일이없으면_건너뛰고적는다', async () => {
  const dir = repo('contract-breaking-');
  commit(dir, { 'README.md': 'x' }, 'chore: 처음');
  git(dir, 'branch', 'develop');
  commit(dir, base, 'feat: 계약');
  const f = fake();
  // 수준 파일이 처음 들어오며 기본보다 낮춘 줄(Avro 열거 더하기 WARN)이 있어 승인 라벨을 준다
  const r = await check(dir, f, { labels: ['breaking-approved'] });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(r.failures, []);
  assert.match(r.notes.join('\n'), /docs\/api\/openapi\.yaml이 없어/);
  assert.match(r.notes.join('\n'), /docs\/api\/asyncapi\.yaml이 없어/);
});

test('낮음019_예외줄마다_이유가있어야한다', () => {
  const ok = parseIgnore('# 주석\n\nGET /v1/a removed the `200` status  # 이유: 초안 정리\n', 'x.txt');
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.entries.map((e) => e.change), ['GET /v1/a removed the `200` status']);
  const bad = parseIgnore('GET /v1/a removed the `200` status\nGET /v1/b x  # 이유:   \n', 'x.txt');
  assert.equal(bad.errors.length, 2);
  assert.match(bad.errors[0], /x\.txt:1/);
  const ov = parseOverrides('{ "/channels/b": { "reason": "초안 채널 정리", "remove": "non-breaking" }, "/channels/c": { "remove": "non-breaking" } }', 'o.json');
  assert.deepEqual(ov.cli, { '/channels/b': { remove: 'non-breaking' }, '/channels/c': { remove: 'non-breaking' } });
  assert.equal(ov.errors.length, 1);
  assert.match(ov.errors[0], /\/channels\/c/);
  assert.match(parseOverrides('{ 깨진', 'o.json').errors[0], /o\.json/);
});

test('낮음019_예외가늘었는데_breaking-approved라벨이없으면_실패한다', async () => {
  const dir = project();
  commit(dir, { 'docs/api/breaking/openapi-ignore.txt': '# 예외 없음\nGET /v1/a removed the `200` status  # 이유: 초안 정리\n' }, 'feat: 예외');
  const without = await check(dir, fake());
  assert.match(without.failures.join('\n'), /breaking-approved/);
  assert.match(without.failures.join('\n'), /GET \/v1\/a removed/);
  assert.deepEqual((await check(dir, fake(), { labels: ['breaking-approved'] })).failures, []);
  // 푸시(병합 뒤)에는 PR 라벨이 없다. PR에서 이미 본 것이라 묻지 않는다
  assert.deepEqual((await check(dir, fake(), { pullRequest: false })).failures, []);
});

test('낮음019_이유없는예외는_실패하고_reason은_CLI에넘기지않는다', async () => {
  const dir = project();
  commit(dir, { 'docs/api/breaking/asyncapi-overrides.json': '{ "/channels/b": { "remove": "non-breaking" } }\n' }, 'feat: 예외');
  const r = await check(dir, fake(), { labels: ['breaking-approved'] });
  assert.match(r.failures.join('\n'), /asyncapi-overrides\.json.*\/channels\/b.*이유/);
  const dir2 = project();
  commit(dir2, { 'docs/api/breaking/asyncapi-overrides.json': '{ "/channels/b": { "reason": "초안 채널 정리", "remove": "non-breaking" } }\n' }, 'feat: 예외');
  const f = fake();
  const r2 = await check(dir2, f, { labels: ['breaking-approved'] });
  assert.deepEqual(r2.failures, []);
  const diff = f.calls.find((c) => c.tool === 'asyncapi');
  assert.deepEqual(JSON.parse(diff.files['/w/asyncapi-overrides.json']), { '/channels/b': { remove: 'non-breaking' } });
});

test('DT48_도구가돌지못하면_닫힌쪽으로실패한다', async () => {
  const dir = project();
  const f = fake();
  const r = await check(dir, { run: async () => { throw new Error('docker를 찾지 못함'); }, convert: f.convert });
  assert.equal(r.failures.length, 4); // OpenAPI, 채널·작업, 메시지 본문(JSON·Avro)
  assert.match(r.failures[0], /docker를 찾지 못함/);
  const broken = await check(dir, { run: f.run, convert: () => { throw new Error('변환 실패'); } });
  assert.match(broken.failures.join('\n'), /메시지 본문.*변환 실패/);
});

test('DT48_설정파일이없으면_실패한다', async () => {
  const dir = repo('contract-breaking-');
  commit(dir, { 'docs/api/openapi.yaml': OPENAPI, 'docs/api/asyncapi.yaml': ASYNCAPI }, 'chore: 계약만');
  git(dir, 'branch', 'develop');
  const r = await check(dir, fake());
  assert.match(r.failures.join('\n'), /docs\/api\/breaking\/openapi-levels\.txt/);
});

test('DT48_이미지는_다이제스트로고정한다', () => {
  assert.match(IMAGES.oasdiff, /^tufin\/oasdiff@sha256:[0-9a-f]{64}$/);
  assert.match(IMAGES.asyncapi, /^asyncapi\/cli@sha256:[0-9a-f]{64}$/);
});

test('DT38_openapi:emit을가진서비스를찾는다', () => {
  const root = tempDir('services-');
  assert.deepEqual(serviceTargets(root), []);
  for (const [name, scripts] of [['queue-svc', { 'openapi:emit': 'node emit.mjs' }], ['ticket-svc', { build: 'tsc' }]]) {
    mkdirSync(join(root, 'services', name), { recursive: true });
    writeFileSync(join(root, 'services', name, 'package.json'), JSON.stringify({ name: `@peaket/${name}`, scripts }));
  }
  assert.deepEqual(serviceTargets(root), ['services/queue-svc']);
});

test('낮음019_라벨은_사건파일에서읽는다', async () => {
  const { labelsFromEvent } = await import('./contract-breaking.mjs');
  const dir = tempDir('event-');
  const file = join(dir, 'event.json');
  writeFileSync(file, JSON.stringify({ pull_request: { labels: [{ name: 'breaking-approved' }, { name: 'docs' }] } }));
  assert.deepEqual(labelsFromEvent(file), ['breaking-approved', 'docs']);
  writeFileSync(file, JSON.stringify({ ref: 'refs/heads/develop' }));
  assert.deepEqual(labelsFromEvent(file), []);
  assert.throws(() => labelsFromEvent(join(dir, 'none.json')), /사건 파일/);
});

test('낮음019_샵으로시작하는줄도_도구에는넘기지않는다', async () => {
  // oasdiff는 # 줄도 예외로 읽는다. 스크립트가 본 예외(이유를 단 줄)만 담은 사본을 넘겨야 라벨·이유 검사를 비켜 가지 못한다
  const dir = project();
  commit(dir, { 'docs/api/breaking/openapi-ignore.txt': '# GET /v1/b removed the `200` status\nGET /v1/a removed the `200` status  # 이유: 초안 정리\n' }, 'feat: 예외');
  const f = fake();
  await check(dir, f, { labels: ['breaking-approved'] });
  const rest = f.calls.find((c) => c.tool === 'oasdiff' && '/w/new.openapi.yaml' in c.files);
  assert.equal(rest.files['/w/openapi-ignore.txt'], 'GET /v1/a removed the `200` status\n');
});

test('낮음019_수준파일을낮추면_breaking-approved라벨이있어야한다', async () => {
  const lowered = project();
  commit(lowered, { 'docs/api/breaking/openapi-levels.txt': 'response-optional-property-removed INFO\napi-path-removed-without-deprecation NONE\n' }, 'chore: 수준 낮춤');
  const r = await check(lowered, fake());
  assert.match(r.failures.join('\n'), /수준.*breaking-approved/);
  assert.match(r.failures.join('\n'), /response-optional-property-removed ERR → INFO/);
  assert.match(r.failures.join('\n'), /api-path-removed-without-deprecation \(기본\) → NONE/);
  assert.deepEqual((await check(lowered, fake(), { labels: ['breaking-approved'] })).failures, []);
  const raised = project();
  commit(raised, { 'docs/api/breaking/openapi-levels.txt': 'response-optional-property-removed ERR\nresponse-mediatype-enum-value-removed ERR\n' }, 'chore: 수준 올림');
  assert.deepEqual((await check(raised, fake())).failures, []);
});

test('낮음019_예외덮어쓰기의_값을넓혀도_라벨이있어야한다', async () => {
  const dir = project();
  commit(dir, { 'docs/api/breaking/asyncapi-overrides.json': '{ "/channels/b": { "reason": "정리", "remove": "non-breaking" } }\n' }, 'feat: 예외');
  git(dir, 'branch', '-f', 'develop');
  commit(dir, { 'docs/api/breaking/asyncapi-overrides.json': '{ "/channels/b": { "reason": "정리", "remove": "non-breaking", "edit": "non-breaking" } }\n' }, 'feat: 예외 넓힘');
  assert.match((await check(dir, fake())).failures.join('\n'), /breaking-approved/);
});

test('DT48_대상가지가앞서가도_갈라진점과견준다', async () => {
  const dir = project();
  commit(dir, { 'docs/api/openapi.yaml': `${OPENAPI}# PR\n` }, 'feat: PR의 변경');
  git(dir, 'checkout', '-q', 'develop');
  commit(dir, { 'docs/api/openapi.yaml': `${OPENAPI}# 대상 가지에 새로 생긴 것\n` }, 'feat: 대상 가지가 앞서감');
  git(dir, 'checkout', '-q', 'main');
  const fork = git(dir, 'merge-base', 'HEAD', 'develop');
  const { bases } = chooseBases({ cwd: dir, target: 'develop' });
  assert.equal(bases[0].sha, fork);
  const f = fake();
  await check(dir, f);
  assert.equal(f.calls.find((c) => '/w/base.openapi.yaml' in c.files).files['/w/base.openapi.yaml'], OPENAPI);
});
