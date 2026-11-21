// BAT-087 데모 무대의 이미지 10개(서비스 5·앱 5)와 빌드 계획(docs/review/plans/BAT-087.md §4 G1·§5).
// 이미지 이름은 peaket/<워크로드>:demo이고, kind에는 pullPolicy Never로 싣는다. GHCR·서명은 첫 출시 묶음 몫이다.
// - 기존 이미지 재사용: bundle(queue·admission·purchase·payment), ops-svc, pg-simulator
// - 새 이미지: identity-svc·ticket-svc·trust-svc·core-svc·realtime-gw, web·partner·console-host·scanner·queue-room
// - `--check`는 폴더·이름·기본 이미지 다이제스트·latest 없음·비루트 사용자·.dockerignore 예외를 정적으로 본다(DS-01).
// - `--build`는 Docker 잠금 안에서만 부른다(ADR-0283 결정 4). 클러스터 적재는 `cluster.mjs demo`가 한다.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoOrigins } from './demo-objects.mjs';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** template/Dockerfile·bundle/Dockerfile과 같은 Node 판(여러 플랫폼 목록의 다이제스트) */
export const DEMO_NODE_IMAGE = 'node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d';
/** 정적 앱의 실행 이미지(v1 대기 상태 캐시와 같은 판·다이제스트). 루트가 아닌 nginx(101) */
export const DEMO_NGINX_IMAGE = 'nginxinc/nginx-unprivileged:1.29.3-alpine@sha256:5aea7cc516b419e3526f47dd1531be31a56a046cfe44754d94f9383e13e2ee99';

/** 새로 만드는 서비스 다섯(이미지가 없던 것) */
export const DEMO_SERVICE_WORKLOADS = Object.freeze(['identity-svc', 'ticket-svc', 'trust-svc', 'core-svc', 'realtime-gw']);
/** 새로 만드는 앱 다섯(widgets는 console-host에 묶이고 forensics는 S1~S9 밖이다) */
export const DEMO_APP_WORKLOADS = Object.freeze(['web', 'partner', 'console-host', 'scanner', 'queue-room']);
/** 새로 만드는 이미지 열 */
export const DEMO_NEW_WORKLOADS = Object.freeze([...DEMO_SERVICE_WORKLOADS, ...DEMO_APP_WORKLOADS]);
/** 기존 이미지를 그대로 쓰는 워크로드(빌드하지 않는다) */
export const DEMO_REUSED_IMAGES = Object.freeze({
  bundle: 'peaket/bundle:demo',
  'ops-svc': 'peaket/ops-svc:demo',
  'pg-simulator': 'peaket/pg-simulator:demo',
});

/** 데모 무대가 만드는 이미지 하나. dockerfile은 저장소 뿌리 기준 상대 경로다 */
function entry(workload, kind, dockerfile, extra = {}) {
  return Object.freeze({
    workload,
    kind,
    image: `peaket/${workload}:demo`,
    dockerfile,
    base: kind === 'service' ? DEMO_NODE_IMAGE : workload === 'web' || workload === 'partner' ? DEMO_NODE_IMAGE : DEMO_NGINX_IMAGE,
    user: kind === 'service' || workload === 'web' || workload === 'partner' ? 'node' : '101',
    buildArgs: DEMO_BUILD_ARGS[workload] ?? Object.freeze({}),
    ...extra,
  });
}

/**
 * 빌드할 때 구워 넣는 데모 출처(브라우저 Origin은 포트를 포함한다).
 * 운영 기본값(포트 없음)으로 빌드한 queue-room은 S2의 매진 상태 파일(`/_q/...`·queue-files:18442)을 읽지 못한다(BAT-086 V-T7).
 * Dockerfile이 `ARG <이름>`을 선언해야 넘긴 값이 쓰인다(`--check`가 본다). 키는 {@link dockerBuildArgs}가 `--build-arg`로 붙인다.
 */
export function demoBuildArgs(origins = demoOrigins()) {
  return Object.freeze({
    'queue-room': Object.freeze({
      VITE_PEAKET_API_ORIGIN: origins.api,
      VITE_PEAKET_QUEUE_ORIGIN: origins.queue,
      VITE_PEAKET_QUEUE_FILES_ORIGIN: origins['queue-files'],
    }),
  });
}

/** 워크로드별 데모 build-arg */
export const DEMO_BUILD_ARGS = demoBuildArgs();
/** 데모 빌드에 반드시 넘겨야 하는 build-arg(빠지면 S2 같은 시나리오가 조용히 깨진다) */
export const DEMO_REQUIRED_BUILD_ARGS = Object.freeze({
  'queue-room': Object.freeze(['VITE_PEAKET_API_ORIGIN', 'VITE_PEAKET_QUEUE_ORIGIN', 'VITE_PEAKET_QUEUE_FILES_ORIGIN']),
});

/**
 * 새 이미지 열(빌드 차례: 기반 패키지를 먼저 쓰는 서비스 → 앱).
 * dockerfile은 저장소 뿌리에서 `docker build -f <dockerfile> -t peaket/<워크로드>:demo .`로 부른다.
 */
export const DEMO_IMAGES = Object.freeze([
  entry('identity-svc', 'service', 'services/identity-svc/Dockerfile'),
  entry('ticket-svc', 'service', 'services/ticket-svc/Dockerfile'),
  entry('trust-svc', 'service', 'services/trust-svc/Dockerfile'),
  entry('core-svc', 'service', 'services/core-svc/Dockerfile'),
  entry('realtime-gw', 'service', 'services/realtime-gw/Dockerfile'),
  entry('web', 'app', 'apps/web/Dockerfile'),
  entry('partner', 'app', 'apps/partner/Dockerfile'),
  entry('console-host', 'app', 'apps/console-host/Dockerfile'),
  entry('scanner', 'app', 'apps/scanner/Dockerfile'),
  entry('queue-room', 'app', 'apps/web/queue-room/Dockerfile'),
]);

/** 정적 앱의 nginx 설정(저장소에 커밋한다) */
export const DEMO_NGINX_CONFS = Object.freeze({
  'console-host': 'deploy/local/demo/nginx/console-host.conf',
  scanner: 'deploy/local/demo/nginx/scanner.conf',
  'queue-room': 'deploy/local/demo/nginx/queue-room.conf',
});

/** `.dockerignore`가 다시 열어야 하는 경로(앱·서비스 이미지가 빌드 맥락에서 보이게) */
export const DEMO_DOCKERIGNORE_PATHS = Object.freeze([
  '!services/identity-svc',
  '!services/ticket-svc',
  '!services/trust-svc',
  '!services/core-svc',
  '!services/realtime-gw',
  '!apps/web',
  '!apps/partner',
  '!apps/console-host',
  '!apps/scanner',
  '!apps/widgets',
  '!deploy/local/demo/nginx',
]);

const latest = /(^|[\s:])latest([\s@]|$)/;

/**
 * Dockerfile 하나를 정적으로 본다: 기본 이미지가 다이제스트로 고정됐고 latest가 없으며, 마지막 단계가 비루트 사용자다(DS-01).
 * @param {string} file 저장소 뿌리 기준 경로 @param {{ user: string }} o
 * @returns {string[]} 문제 목록(비었으면 통과)
 */
export function dockerfileProblems(file, o) {
  const text = readFileSync(join(REPO, file), 'utf8');
  const problems = [];
  const froms = [...text.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/gim)];
  if (froms.length === 0) problems.push(`${file}: FROM이 없다`);
  for (const m of froms) {
    const ref = m[1];
    if (!/@sha256:[0-9a-f]{64}$/.test(ref) && !/^scratch$/i.test(ref)) problems.push(`${file}: FROM ${ref}에 @sha256 다이제스트가 없다`);
    if (latest.test(ref)) problems.push(`${file}: FROM ${ref}에 latest가 있다`);
  }
  if (latest.test(text.replace(/^#.*$/gm, ''))) problems.push(`${file}: latest 태그가 있다`);
  // 마지막 실행 단계의 USER(마지막 FROM 뒤). 없거나 root면 실패
  const lastFrom = text.lastIndexOf('\nFROM ');
  const tail = lastFrom < 0 ? text : text.slice(lastFrom);
  const users = [...tail.matchAll(/^USER\s+(\S+)/gim)].map((m) => m[1].toLowerCase());
  const user = users.at(-1);
  if (!user) problems.push(`${file}: 실행 단계에 USER가 없다(비루트)`);
  else if (['root', '0', '0:0'].includes(user)) problems.push(`${file}: 실행 단계가 root다`);
  else if (o?.user === 'node' && !/^(node|\d+)$/.test(user)) problems.push(`${file}: 실행 단계 USER가 node가 아니다(${user})`);
  return problems;
}

/** `.dockerignore`가 앱·서비스·nginx 경로를 다시 열었는지 */
export function dockerignoreProblems(text = readFileSync(join(REPO, '.dockerignore'), 'utf8')) {
  const lines = new Set(text.split(/\r?\n/).map((s) => s.trim()));
  return DEMO_DOCKERIGNORE_PATHS.filter((p) => !lines.has(p)).map((p) => `.dockerignore에 ${p}가 없다`);
}

/**
 * 이미지 하나의 데모 build-arg가 Dockerfile의 `ARG` 선언과 맞는지 본다(V-T7 ④ `--check`).
 * Dockerfile에 ARG가 없으면 `--build-arg`는 조용히 무시되고 운영 기본값(포트 없음)이 구워진다.
 * @param {{ workload: string, dockerfile: string, buildArgs?: Record<string, string> }} i
 * @param {Record<string, string[]>} required
 */
export function buildArgsProblems(i, required = DEMO_REQUIRED_BUILD_ARGS) {
  const problems = [];
  const args = i.buildArgs ?? {};
  const declared = new Set([...readFileSync(join(REPO, i.dockerfile), 'utf8').matchAll(/^ARG\s+([A-Za-z0-9_]+)/gm)].map((m) => m[1]));
  const origins = new Set(Object.values(demoOrigins()));
  for (const name of required[i.workload] ?? []) {
    if (!(name in args)) problems.push(`${i.dockerfile}: 필수 build-arg ${name}가 빠졌다`);
  }
  for (const [name, value] of Object.entries(args)) {
    if (!declared.has(name)) problems.push(`${i.dockerfile}: build-arg ${name}를 받는 ARG가 없다(넘겨도 무시된다)`);
    if (!/:18\d{3}(?:\/|$)/.test(value)) problems.push(`${i.dockerfile}: build-arg ${name}=${value}에 이 PC 포트가 없다`);
    else if (!origins.has(value)) problems.push(`${i.dockerfile}: build-arg ${name}=${value}가 demoOrigins에 없다`);
  }
  return problems;
}

/** docker build 명령(저장소 뿌리 맥락). 데모 출처 build-arg를 함께 넘긴다 */
export function dockerBuildArgs(i) {
  const args = ['build', '-f', join(REPO, i.dockerfile), '-t', i.image];
  for (const [name, value] of Object.entries(i.buildArgs ?? {})) args.push('--build-arg', `${name}=${value}`);
  args.push(REPO);
  return args;
}

/**
 * `--check`(기본)·`--build` 인자. --check는 정적 점검, --build는 10개를 차례로 빌드한다.
 * @param {string[]} argv
 */
export function demoImagesPlan(argv = []) {
  let mode = 'check';
  for (const a of argv) {
    if (a === '--check') mode = 'check';
    else if (a === '--build') mode = 'build';
    else if (a === '--json') continue;
    else throw new Error(`demo-images의 모르는 인자: ${a}(쓰는 법: --check|--build [--json])`);
  }
  return { mode };
}

/**
 * 정적 점검 결과. 워크로드마다 dockerfile·image·problems를 담는다(DS-01이 읽는다).
 * @returns {{ ok: boolean, images: { workload: string, image: string, dockerfile: string, problems: string[] }[], problems: string[] }}
 */
export function checkImages() {
  const images = DEMO_IMAGES.map((i) => {
    const problems = [];
    if (!existsSync(join(REPO, i.dockerfile))) problems.push(`${i.dockerfile}이 없다`);
    else {
      problems.push(...dockerfileProblems(i.dockerfile, { user: i.user }));
      problems.push(...buildArgsProblems(i));
    }
    if (DEMO_NGINX_CONFS[i.workload] && !existsSync(join(REPO, DEMO_NGINX_CONFS[i.workload]))) problems.push(`${DEMO_NGINX_CONFS[i.workload]}이 없다`);
    return { workload: i.workload, image: i.image, dockerfile: i.dockerfile, buildArgs: i.buildArgs ?? {}, problems };
  });
  const shared = dockerignoreProblems();
  const problems = [...shared, ...images.flatMap((i) => i.problems)];
  return { ok: problems.length === 0, images, problems };
}

/** 이미지 하나를 저장소 뿌리 맥락에서 빌드한다(데모 출처 build-arg 포함) */
export function buildImage(i) {
  execFileSync('docker', dockerBuildArgs(i), { stdio: 'inherit' });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plan = demoImagesPlan(process.argv.slice(2));
  const json = process.argv.includes('--json');
  if (plan.mode === 'build') {
    for (const i of DEMO_IMAGES) {
      console.log(`\n== ${i.image} (${i.dockerfile})`);
      buildImage(i);
    }
    console.log(`\n준비됨: ${DEMO_IMAGES.map((i) => i.image).join(', ')}`);
    process.exit(0);
  }
  const result = checkImages();
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (result.ok) console.log(`이미지 ${DEMO_IMAGES.length}개 계획이 맞다: ${DEMO_IMAGES.map((i) => i.image).join(', ')}`);
  else console.error(result.problems.join('\n'));
  process.exit(result.ok ? 0 : 1);
}
