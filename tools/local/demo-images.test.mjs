// BAT-087 데모 무대 이미지 계획(DS-01)과 이미지 구성의 비밀 없음(DS-12)을 정적으로 본다.
// 정본: docs/review/plans/BAT-087.md §5 '이미지·워크로드', §6 DS-01·DS-12, §9 M1.
// - 새 이미지 열: peaket/<워크로드>:demo, base는 @sha256 다이제스트 고정, latest 없음, 실행 단계 비루트(node·101)
// - .dockerignore가 앱·서비스·nginx 경로를 다시 연다
// - 로컬 오버레이 13개는 image.tag demo·pullPolicy Never·PEAKET_ENV local이고, 포트 붙은 출처를 쓴다
// - W12S-02: 이미지(ENV·ARG·빌드 인자)에 키·비밀 이름을 굽지 않는다(docs/review/plans/W12-ci-sec.md §3)
// 실행(저장소 뿌리): node --test "tools/local/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { DEMO_BUILD_ARGS, DEMO_IMAGES, DEMO_NGINX_CONFS, DEMO_NGINX_IMAGE, DEMO_NODE_IMAGE, DEMO_DOCKERIGNORE_PATHS, DEMO_REQUIRED_BUILD_ARGS, buildArgsProblems, checkImages, demoImagesPlan, dockerBuildArgs, dockerfileProblems, dockerignoreProblems } from './demo-images.mjs';
import { DEMO_WORKLOADS, DEMO_IMAGES as DEMO_WORKLOAD_IMAGES, DEMO_OVERLAY_DIR, demoOrigins } from './demo-objects.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OVERLAY = join(REPO, DEMO_OVERLAY_DIR);
/** 새 이미지 열의 워크로드 이름(계획 §5 표) */
const NEW_WORKLOADS = ['identity-svc', 'ticket-svc', 'trust-svc', 'core-svc', 'realtime-gw', 'web', 'partner', 'console-host', 'scanner', 'queue-room'];
/** 기존 이미지를 그대로 쓰는 셋(빌드하지 않는다) */
const REUSED = ['bundle', 'ops-svc', 'pg-simulator'];

test('DS-01 이미지 계획은 새 이미지 열 개이고 모두 peaket/<워크로드>:demo이며 latest가 없다', () => {
  assert.deepEqual(DEMO_IMAGES.map((i) => i.workload), NEW_WORKLOADS, '새 이미지 열의 워크로드 목록');
  assert.equal(DEMO_IMAGES.length, 10, `이미지 수 ${DEMO_IMAGES.length}`);
  for (const i of DEMO_IMAGES) {
    assert.equal(i.image, `peaket/${i.workload}:demo`, `${i.workload}의 이미지 이름`);
    assert.doesNotMatch(i.image, /:latest$/, `${i.workload}의 이미지 태그가 latest다`);
  }
  // 오브젝트 쪽 이미지 표도 같은 이름을 쓴다(빌드 계획과 설치 값이 갈라지지 않게)
  for (const name of NEW_WORKLOADS) assert.equal(DEMO_WORKLOAD_IMAGES[name], `peaket/${name}:demo`, `demo-objects의 ${name} 이미지`);
  for (const name of REUSED) assert.equal(DEMO_WORKLOAD_IMAGES[name], `peaket/${name}:demo`, `재사용 이미지 ${name}`);
  assert.equal(DEMO_WORKLOAD_IMAGES['v0-monolith'], undefined, '데모에 v0 모놀리스가 들어 있다');
});

test('DS-01 Dockerfile 열 개가 다이제스트 고정·latest 없음·비루트 실행 단계다', () => {
  assert.equal(checkImages().ok, true, `정적 점검이 실패했다: ${checkImages().problems.join('; ')}`);
  for (const i of DEMO_IMAGES) {
    const file = join(REPO, i.dockerfile);
    assert.ok(existsSync(file), `${i.dockerfile}이 없다`);
    const text = readFileSync(file, 'utf8');
    const froms = [...text.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+\S+)?/gim)].map((m) => m[1]);
    assert.ok(froms.length >= 1, `${i.dockerfile}에 FROM이 없다`);
    for (const ref of froms) assert.match(ref, /@sha256:[0-9a-f]{64}$/, `${i.dockerfile}의 FROM ${ref}에 다이제스트가 없다`);
    assert.doesNotMatch(text.replace(/^#.*$/gm, ''), /(^|[\s:])latest([\s@]|$)/, `${i.dockerfile}에 latest 태그가 있다`);
    const tail = text.slice(text.lastIndexOf('\nFROM '));
    const users = [...tail.matchAll(/^USER\s+(\S+)/gim)].map((m) => m[1]);
    assert.ok(users.length >= 1, `${i.dockerfile}의 실행 단계에 USER가 없다`);
    assert.doesNotMatch(users.at(-1), /^(root|0|0:0)$/i, `${i.dockerfile}의 실행 단계가 root다`);
    assert.deepEqual(dockerfileProblems(i.dockerfile, { user: i.user }), [], `${i.dockerfile} 정적 문제`);
    if (i.kind === 'service') {
      assert.match(text, /^USER\s+node$/im, `${i.dockerfile}의 실행 사용자가 node가 아니다`);
      assert.match(text, /CMD\s+\[.*dist\/main\.js/, `${i.dockerfile}의 CMD가 dist/main.js를 부르지 않는다`);
    }
    if (i.workload === 'web' || i.workload === 'partner') {
      assert.match(text, /^USER\s+node$/im, `${i.dockerfile}의 실행 사용자가 node가 아니다`);
      assert.match(text, /standalone|server\.js|start\.mjs/, `${i.dockerfile}이 Next.js standalone 산출물을 쓰지 않는다`);
    }
    if (DEMO_NGINX_CONFS[i.workload]) {
      assert.match(text, /^USER\s+101$/im, `${i.dockerfile}의 실행 사용자가 101(비루트 nginx)이 아니다`);
      assert.ok(text.includes(DEMO_NGINX_IMAGE.split('@')[0]), `${i.dockerfile}의 기본 이미지가 고정 nginx 판이 아니다`);
      assert.ok(text.includes(DEMO_NGINX_CONFS[i.workload]), `${i.dockerfile}이 nginx 설정 ${DEMO_NGINX_CONFS[i.workload]}을 넣지 않는다`);
    }
    if (i.kind === 'service') assert.ok(text.includes(DEMO_NODE_IMAGE.split('@')[0]), `${i.dockerfile}의 기본 이미지가 고정 Node 판이 아니다`);
  }
});

test('DS-01 .dockerignore가 앱·서비스·nginx 경로를 다시 열고, 앱 디렉터리를 통째로 빼지 않는다', () => {
  const text = readFileSync(join(REPO, '.dockerignore'), 'utf8');
  const lines = new Set(text.split(/\r?\n/).map((s) => s.trim()));
  assert.deepEqual(dockerignoreProblems(text), [], '.dockerignore 예외가 빠졌다');
  for (const p of DEMO_DOCKERIGNORE_PATHS) assert.ok(lines.has(p), `.dockerignore에 ${p}가 없다`);
  assert.ok(!lines.has('!apps'), '.dockerignore가 apps를 통째로 다시 열었다(불필요한 원본·시험이 이미지에 들어간다)');
  assert.ok(!lines.has('!services'), '.dockerignore가 services를 통째로 다시 열었다');
  for (const p of ['!apps/web', '!apps/partner', '!apps/console-host', '!apps/scanner', '!apps/widgets']) assert.ok(lines.has(p), `앱 경로 ${p} 예외가 없다`);
});

test('DS-01 로컬 오버레이 13개가 demo 태그·Never·PEAKET_ENV local이고 image.repository가 워크로드와 같다', () => {
  for (const w of DEMO_WORKLOADS) {
    const file = join(OVERLAY, `${w.name}.yaml`);
    assert.ok(existsSync(file), `${DEMO_OVERLAY_DIR}/${w.name}.yaml이 없다`);
    const values = parseYaml(readFileSync(file, 'utf8'));
    assert.equal(values.name, w.name, `${w.name}.yaml의 name`);
    assert.equal(values.image?.repository, `peaket/${w.name}`, `${w.name}.yaml의 image.repository`);
    assert.equal(values.image?.tag, 'demo', `${w.name}.yaml의 image.tag`);
    assert.equal(values.image?.pullPolicy, 'Never', `${w.name}.yaml의 image.pullPolicy`);
    assert.equal(values.env?.PEAKET_ENV, 'local', `${w.name}.yaml의 PEAKET_ENV(로컬 데모는 local이다)`);
    assert.doesNotMatch(readFileSync(file, 'utf8'), /:latest\b/, `${w.name}.yaml에 latest 태그가 있다`);
  }
  // 오버레이 폴더에는 워크로드 13개와 README만 있다(클라우드 값과 섞지 않는다)
  assert.deepEqual(
    readdirSync(OVERLAY).sort(),
    [...DEMO_WORKLOADS.map((w) => `${w.name}.yaml`), 'README.md'].sort(),
    `${DEMO_OVERLAY_DIR}의 파일 목록`,
  );
});

test('RV-09 정적 앱 셋(console-host·scanner·queue-room)의 워크로드 기본 명령은 nginx다', () => {
  for (const name of ['console-host', 'scanner', 'queue-room']) {
    const file = join(REPO, 'deploy', 'workloads', name, 'values.yaml');
    const values = parseYaml(readFileSync(file, 'utf8'));
    assert.deepEqual(values.service?.command, ['nginx', '-g', 'daemon off;'], `${name} 기본 명령이 nginx가 아니다(다음 환경이 시작하지 않는다)`);
  }
});

test('DS-01 오버레이·게이트웨이·문서에 latest 태그나 IfNotPresent가 없다(demo는 Never)', () => {
  for (const w of DEMO_WORKLOADS) {
    const values = parseYaml(readFileSync(join(OVERLAY, `${w.name}.yaml`), 'utf8'));
    assert.notEqual(values.image?.pullPolicy, 'IfNotPresent', `${w.name}.yaml의 pullPolicy가 IfNotPresent다(kind가 옛 이미지를 쓴다)`);
  }
  const web = parseYaml(readFileSync(join(OVERLAY, 'web.yaml'), 'utf8'));
  assert.equal(web.service?.port, 3000, 'web의 포트가 3000이 아니다');
  const partner = parseYaml(readFileSync(join(OVERLAY, 'partner.yaml'), 'utf8'));
  assert.equal(partner.service?.port, 3001, 'partner의 포트가 3001이 아니다');
  // bundle 하나가 queue·admission·purchase·payment를 덮는다(감독 결정 2)
  const bundle = parseYaml(readFileSync(join(OVERLAY, 'bundle.yaml'), 'utf8'));
  assert.equal(bundle.service?.replicas, 1, 'bundle 복제 수');
  assert.match(bundle.env?.PEAKET_BUNDLE_SERVICES ?? '', /queue-svc/, 'bundle이 queue-svc를 덮지 않는다');
  assert.match(bundle.env?.PEAKET_BUNDLE_SERVICES ?? '', /admission-ctrl/, 'bundle이 admission-ctrl을 덮지 않는다');
  assert.match(bundle.env?.PEAKET_BUNDLE_SERVICES ?? '', /purchase-svc/, 'bundle이 purchase-svc를 덮지 않는다');
  assert.match(bundle.env?.PEAKET_BUNDLE_SERVICES ?? '', /payment-svc/, 'bundle이 payment-svc를 덮지 않는다');
});

test('DS-04 오버레이의 출처는 포트를 포함한다(PEAKET_WEB_ORIGIN·콘솔 출처)', () => {
  const origins = new Set(Object.values(demoOrigins()));
  let seen = 0;
  for (const w of DEMO_WORKLOADS) {
    const values = parseYaml(readFileSync(join(OVERLAY, `${w.name}.yaml`), 'utf8'));
    const env = values.env ?? {};
    for (const [key, value] of Object.entries(env)) {
      if (!/(?:ORIGIN|URL)$/.test(key) || typeof value !== 'string' || !value.startsWith('https://')) continue;
      if (key.endsWith('_URL') && /svc\.cluster\.local/.test(value)) continue;
      seen += 1;
      assert.match(value, /:18\d{3}(?:\/|$)/, `${w.name}.yaml의 ${key} ${value}에 이 PC 포트가 없다`);
      assert.ok(origins.has(value), `${w.name}.yaml의 ${key} ${value}가 demoOrigins에 없다`);
    }
  }
  assert.ok(seen > 0, '오버레이에 포트 붙은 출처가 하나도 없다');
  // 빌드 시점에 굽는 소비자 웹·파트너의 공개 출처도 포트를 포함한다
  for (const file of ['apps/web/Dockerfile', 'apps/partner/Dockerfile']) {
    const text = readFileSync(join(REPO, file), 'utf8');
    for (const m of text.matchAll(/NEXT_PUBLIC_[A-Z_]+_ORIGIN=(\S+)/g)) {
      assert.match(m[1], /:18\d{3}$/, `${file}의 ${m[0]}에 포트가 없다`);
    }
  }
});

test('DS-12 이미지 계획·Dockerfile에 비밀 값이나 개인 키가 없다', () => {
  for (const i of DEMO_IMAGES) {
    const text = readFileSync(join(REPO, i.dockerfile), 'utf8');
    assert.doesNotMatch(text, /BEGIN (?:RSA |EC )?PRIVATE KEY/, `${i.dockerfile}에 개인 키가 있다`);
    assert.doesNotMatch(text, /\bBearer\s+[A-Za-z0-9._-]{8,}/, `${i.dockerfile}에 Bearer 토큰이 있다`);
    assert.doesNotMatch(text, /(?:PASSWORD|SECRET|TOTP)=[^"\s]+/i, `${i.dockerfile}에 비밀 값이 박혀 있다`);
  }
  for (const file of Object.values(DEMO_NGINX_CONFS)) {
    const text = readFileSync(join(REPO, file), 'utf8');
    assert.doesNotMatch(text, /BEGIN (?:RSA |EC )?PRIVATE KEY|Bearer\s+/i, `${file}에 비밀 값이 있다`);
  }
});

test('V-T7 ④ 깨끗한 빌드는 포트 붙은 데모 출처를 VITE_* build-arg로 넘긴다(S2 매진 파일)', () => {
  const expected = {
    VITE_PEAKET_API_ORIGIN: demoOrigins().api,
    VITE_PEAKET_QUEUE_ORIGIN: demoOrigins().queue,
    VITE_PEAKET_QUEUE_FILES_ORIGIN: demoOrigins()['queue-files'],
  };
  assert.equal(expected.VITE_PEAKET_QUEUE_FILES_ORIGIN, 'https://queue-files.peaket.example:18442', '데모 queue-files 출처에 포트가 없다');
  assert.deepEqual(DEMO_BUILD_ARGS['queue-room'], expected, 'queue-room의 데모 build-arg 계획');
  assert.deepEqual(DEMO_REQUIRED_BUILD_ARGS['queue-room'], Object.keys(expected), 'queue-room의 필수 build-arg 목록');

  // 새로 빌드할 때(--skip-build 없이) 실제 docker 명령에 --build-arg가 붙는다
  const queueRoom = DEMO_IMAGES.find((i) => i.workload === 'queue-room');
  const args = dockerBuildArgs(queueRoom);
  for (const [name, value] of Object.entries(expected)) {
    const at = args.indexOf('--build-arg');
    assert.ok(at >= 0, `docker build 명령에 --build-arg가 없다: ${args.join(' ')}`);
    assert.ok(args.includes(`${name}=${value}`), `docker build 명령에 ${name}=${value}가 없다: ${args.join(' ')}`);
  }
  // 빌드 인자가 필요 없는 이미지에는 붙이지 않는다(운영 기본값을 그대로 쓴다)
  assert.equal(dockerBuildArgs(DEMO_IMAGES.find((i) => i.workload === 'identity-svc')).includes('--build-arg'), false, 'identity-svc에 --build-arg가 붙었다');
  // 데이터가 갈라지지 않게 출처는 demoOrigins 하나만 쓴다
  for (const value of Object.values(expected)) assert.ok(new Set(Object.values(demoOrigins())).has(value), `build-arg 출처 ${value}가 demoOrigins에 없다`);
});

test('V-T7 ④ demo-images --check가 기대 build-arg(ARG 선언·데모 포트)를 검사한다', () => {
  const result = checkImages();
  assert.equal(result.ok, true, `정적 점검이 실패했다: ${result.problems.join('; ')}`);
  const queueRoom = DEMO_IMAGES.find((i) => i.workload === 'queue-room');
  assert.deepEqual(buildArgsProblems(queueRoom), [], 'queue-room의 build-arg 정적 문제');
  assert.deepEqual(result.images.find((i) => i.workload === 'queue-room').buildArgs, DEMO_BUILD_ARGS['queue-room'], '--check 결과에 build-arg가 없다');

  // Dockerfile이 ARG를 받지 않으면 넘겨도 무시된다 → 실패
  const undeclared = buildArgsProblems({ ...queueRoom, dockerfile: 'apps/partner/Dockerfile', buildArgs: { VITE_PEAKET_QUEUE_FILES_ORIGIN: demoOrigins()['queue-files'] } });
  assert.match(undeclared.join('\n'), /VITE_PEAKET_QUEUE_FILES_ORIGIN.*ARG가 없다/, `ARG 없는 build-arg를 잡지 않는다: ${undeclared.join('; ')}`);
  // 포트 없는 출처로 빌드하면 S2가 매진 파일을 읽지 못한다 → 실패
  const noPort = buildArgsProblems({ ...queueRoom, buildArgs: { ...DEMO_BUILD_ARGS['queue-room'], VITE_PEAKET_QUEUE_FILES_ORIGIN: 'https://queue-files.peaket.example' } });
  assert.match(noPort.join('\n'), /VITE_PEAKET_QUEUE_FILES_ORIGIN.*포트가 없다/, `포트 없는 출처를 잡지 않는다: ${noPort.join('; ')}`);
  // 필수 build-arg를 빼면 실패
  const missing = buildArgsProblems({ ...queueRoom, buildArgs: { VITE_PEAKET_API_ORIGIN: demoOrigins().api, VITE_PEAKET_QUEUE_ORIGIN: demoOrigins().queue } });
  assert.match(missing.join('\n'), /VITE_PEAKET_QUEUE_FILES_ORIGIN.*빠졌다/, `빠진 필수 build-arg를 잡지 않는다: ${missing.join('; ')}`);
});

// ---------- W12S-02 이미지에 키·비밀 이름을 굽지 않는다(docs/review/plans/W12-ci-sec.md §3) ----------
// 정본: docs/devops.md §4.4 '시험·데모 값의 꼴과 도구 판' ②(이미지의 ENV·ARG·빌드 인자에 키·비밀 값을 굽지 않는다),
// docs/infra.md '로컬 데모의 비밀'(서버 액션 키는 Secret으로만, 빌드는 키 없이 한다).

/** 키·비밀로 읽히는 이름의 끝(계획 §3 W12S-02) */
const SECRET_NAME = /(?:_KEY|_SECRET|_TOKEN|PASSWORD)$/i;

/**
 * Dockerfile의 ENV·ARG가 정하는 이름들. 줄 끝 `\`로 이은 줄을 한 명령으로 읽고, 이은 줄 사이의 주석 줄은 Docker처럼 뺀다.
 * `ENV 이름=값 …`·`ARG 이름[=기본값] …`과 옛 꼴 `ENV 이름 값`을 받는다.
 * @returns {{ kind: 'ENV' | 'ARG', name: string }[]}
 */
function envArgNames(text) {
  const commands = [];
  let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const continued = /\\\s*$/.test(line);
    const body = continued ? line.replace(/\\\s*$/, ' ') : line;
    cur = cur === null ? body : `${cur} ${body}`;
    if (!continued) {
      commands.push(cur);
      cur = null;
    }
  }
  if (cur !== null) commands.push(cur);
  const out = [];
  for (const c of commands) {
    const m = /^\s*(ENV|ARG)\s+(.*)$/i.exec(c);
    if (!m) continue;
    const kind = /** @type {'ENV' | 'ARG'} */ (m[1].toUpperCase());
    const tokens = m[2].match(/(?:[^\s"']+|"(?:[^"\\]|\\.)*"|'[^']*')+/g) ?? [];
    if (kind === 'ENV' && tokens.length > 0 && !tokens[0].includes('=')) {
      out.push({ kind, name: tokens[0] });
      continue;
    }
    for (const t of tokens) out.push({ kind, name: t.split('=')[0] });
  }
  return out;
}

test('W12S-02 ① 데모 이미지 열 개의 Dockerfile ENV·ARG 이름에 키·비밀 이름(_KEY·_SECRET·_TOKEN·PASSWORD)이 없다(줄 이음 포함)', () => {
  // 읽는 법부터 본다: 이은 줄 안의 이름·주석 줄·옛 꼴 ENV·ARG 여럿을 모두 이름으로 낸다(읽지 못해 조용히 통과하지 않게)
  const sample = ['FROM x AS b', 'ENV A_ORIGIN=1 \\', '    # 이은 줄 사이 주석', '    B_TOKEN=2', 'ARG C_SECRET D_MODE=x', 'ENV E_KEY 3'].join('\n');
  assert.deepEqual(envArgNames(sample).map((n) => `${n.kind} ${n.name}`), ['ENV A_ORIGIN', 'ENV B_TOKEN', 'ARG C_SECRET', 'ARG D_MODE', 'ENV E_KEY']);
  assert.deepEqual(envArgNames(sample).filter((n) => SECRET_NAME.test(n.name)).map((n) => n.name), ['B_TOKEN', 'C_SECRET', 'E_KEY'], '표본의 비밀 이름 셋을 잡지 못했다');

  const found = [];
  for (const i of DEMO_IMAGES) {
    const names = envArgNames(readFileSync(join(REPO, i.dockerfile), 'utf8'));
    assert.ok(names.length >= 1, `${i.dockerfile}에서 ENV·ARG를 하나도 읽지 못했다(읽는 법이 틀렸다)`);
    for (const n of names) if (SECRET_NAME.test(n.name)) found.push(`${i.dockerfile} ${n.kind} ${n.name}`);
  }
  // 이은 줄을 실제로 읽었는지: web의 ENV 덩이 가운데 줄과 queue-room의 ARG를 읽는다
  const web = envArgNames(readFileSync(join(REPO, 'apps/web/Dockerfile'), 'utf8')).map((n) => n.name);
  assert.ok(web.includes('NEXT_PUBLIC_SCANNER_ORIGIN') && web.includes('PEAKET_ENV'), `apps/web/Dockerfile의 이은 ENV 줄을 읽지 못했다: ${web.join(', ')}`);
  const queueRoom = envArgNames(readFileSync(join(REPO, 'apps/web/queue-room/Dockerfile'), 'utf8'));
  assert.ok(queueRoom.some((n) => n.kind === 'ARG' && n.name === 'VITE_PEAKET_API_ORIGIN'), 'queue-room의 ARG를 읽지 못했다');
  assert.deepEqual(found, [], `이미지에 키·비밀 이름이 구워져 있다(실행 때 Secret으로 준다): ${found.join('; ')}`);
});

/** 이미지들의 docker build 명령에서 --build-arg 이름을 모두 읽는다 */
function buildArgNames(images) {
  const out = [];
  for (const i of images) {
    const argv = dockerBuildArgs(i);
    argv.forEach((a, at) => {
      if (a === '--build-arg') out.push({ workload: i.workload, name: String(argv[at + 1] ?? '').split('=')[0] });
    });
  }
  return out;
}

test('W12S-02 ② 데모 빌드 인자(DEMO_BUILD_ARGS·docker build --build-arg)에 키·비밀 이름이 없다', () => {
  // 읽는 법부터 본다: 비밀 이름의 빌드 인자를 붙인 이미지 표본은 잡는다
  const queueRoom = DEMO_IMAGES.find((i) => i.workload === 'queue-room');
  const probe = buildArgNames([{ ...queueRoom, buildArgs: { ...queueRoom.buildArgs, PROBE_TOKEN: 'x' } }]).filter((n) => SECRET_NAME.test(n.name));
  assert.deepEqual(probe.map((n) => n.name), ['PROBE_TOKEN'], '표본의 비밀 이름 빌드 인자를 잡지 못했다');

  const found = [];
  for (const [workload, args] of Object.entries(DEMO_BUILD_ARGS)) for (const name of Object.keys(args)) if (SECRET_NAME.test(name)) found.push(`DEMO_BUILD_ARGS.${workload}.${name}`);
  const passed = buildArgNames(DEMO_IMAGES);
  // queue-room의 출처 셋은 빌드 인자로 넘긴다(넘기는 길을 실제로 읽었는지)
  assert.ok(passed.length >= 3, `docker build 명령에서 --build-arg를 ${passed.length}개만 읽었다`);
  for (const n of passed) if (SECRET_NAME.test(n.name)) found.push(`${n.workload} --build-arg ${n.name}`);
  assert.deepEqual(found, [], `키·비밀을 빌드 인자로 넘긴다(이미지 기록에 남는다): ${found.join('; ')}`);
});

test('W12S-02 ③ 데모 Dockerfile의 명령(주석 뺌) 어디에도 키·비밀 이름에 값을 주는 꼴(이름=)이 없다(RUN 안의 환경 값 포함)', () => {
  const assignments = (text) =>
    [
      ...String(text)
        .split(/\r?\n/)
        .filter((l) => !/^\s*#/.test(l))
        .join('\n')
        .matchAll(/\b[A-Za-z0-9_]*(?:_KEY|_SECRET|_TOKEN|PASSWORD)=/gi),
    ].map((m) => m[0]);
  // 읽는 법부터 본다: RUN 안의 환경 값은 잡고 주석 줄은 보지 않는다
  assert.deepEqual(assignments('# A_KEY=x\nRUN B_SECRET=y pnpm build'), ['B_SECRET='], '표본의 RUN 안 비밀 이름 값을 잡지 못했다');
  const found = [];
  for (const i of DEMO_IMAGES) for (const a of assignments(readFileSync(join(REPO, i.dockerfile), 'utf8'))) found.push(`${i.dockerfile}: ${a}`);
  assert.deepEqual(found, [], `Dockerfile이 키·비밀 이름에 값을 준다: ${found.join('; ')}`);
});

test('DS-01 demo-images 인자는 --check·--build·--json만 받고 모르는 인자는 던진다', () => {
  assert.deepEqual(demoImagesPlan([]), { mode: 'check' });
  assert.deepEqual(demoImagesPlan(['--build']), { mode: 'build' });
  assert.deepEqual(demoImagesPlan(['--check', '--json']), { mode: 'check' });
  assert.throws(() => demoImagesPlan(['--latest']), /모르는 인자/);
});
