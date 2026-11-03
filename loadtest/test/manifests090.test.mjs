// BSL-090 Before 측정(docs/verification.md §3.10 '발생기 나누기'·'K별 실행' K4)이 더한 쿠버네티스 객체와 고정 스크립트의 시험.
// 대상: loadtest/runner/manifests.mjs의 samplerCommand·RUN_SCRIPT_SPLIT·generatorPod(index)·runEnvFile(GEN_INDEX 예약)·deltaClientPod.
// 각 export의 JSDoc을 명세로 보고 계약만 시험한다. 클러스터는 건드리지 않는다.
// RUN_SCRIPT_SPLIT의 동작 시험만 고정한 k6 이미지(K6_IMAGE)의 셸(파드와 같은 busybox sh)로 돌린다: OS 임시 폴더를 /work로 붙이고,
// 받은 것을 적는 가짜 k6·mv·sleep을 PATH 앞에 둔다(10분 기다리기 시험만 sleep을 셸 함수로 바꾼다). 망 없이, 읽기 전용 루트와
// tmpfs /tmp(파드와 같게)로, 이 PC 쪽은 셸 없이 부른다.
// Docker 엔진이 없으면(`docker version` 실패) 그 시험만 건너뛴다. 임시 폴더와 컨테이너는 끝나면 지운다.
// 새 export가 없는 판에서도 시험마다 따로 실패하도록 모듈을 이름공간으로 가져온다.
// 실행: node --test loadtest/test/manifests090.test.mjs
import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import * as manifests from '../runner/manifests.mjs';

const { K6_IMAGE, K6_UID, KIND_NODE, LOADGEN_NAMESPACE, NODE_ROOT, RUN_SCRIPT, SAMPLER_COMMAND, SIM_KEY_NAME, SIM_KEY_SECRET, generatorPod, runEnvFile } = manifests;

// ---------------------------------------------------------------------------------------------
// 공통 도우미
// ---------------------------------------------------------------------------------------------

/** BSL-090이 더한 export. 없는 판에서는 부르는 자리에서 TypeError가 나 그 시험만 실패한다 */
const samplerCommand = (outDir) => manifests.samplerCommand(outDir);
const deltaClientPod = (o) => manifests.deltaClientPod(o);
function splitScript() {
  assert.equal(typeof manifests.RUN_SCRIPT_SPLIT, 'string', 'RUN_SCRIPT_SPLIT는 글이다');
  return manifests.RUN_SCRIPT_SPLIT;
}

/** 거절 시험의 이름표(NaN·undefined·객체도 알아보게) */
const show = (v) => (typeof v === 'string' || Array.isArray(v) ? JSON.stringify(v) : typeof v === 'object' && v !== null ? `객체 ${JSON.stringify(v)}` : String(v));
const envByName = (c) => Object.fromEntries((c.env ?? []).map((e) => [e.name, e]));
/** 컨테이너 하나인 파드의 env 이름 → 값 */
const envMap = (pod) => Object.fromEntries(pod.spec.containers[0].env.map((e) => [e.name, e.value]));
/** 이름으로 고르는 목록(env·volumeMounts·volumes)을 이름순으로 둔 사본. 그 차례는 JSDoc이 정하지 않는다 */
function canon(pod) {
  const p = structuredClone(pod);
  const sort = (list) => [...list].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const c of p.spec.containers) {
    c.env = sort(c.env ?? []);
    c.volumeMounts = sort(c.volumeMounts ?? []);
  }
  p.spec.volumes = sort(p.spec.volumes ?? []);
  return p;
}

/** 바른 입력 폴더(노드의 <NODE_ROOT>/<실행 꼬리표>) */
const HOST_DIR = `${NODE_ROOT}/r1`;
const gpod = (o) => generatorPod({ hostDir: HOST_DIR, ...o });

/** BSL-090 앞의 표본 명령 글(바꾸기 전 manifests.mjs의 SAMPLER_COMMAND[2]를 그대로 옮겼다) */
const SAMPLER_SCRIPT_BEFORE = 'mkdir -p /work/out; (while :; do read up _ < /proc/uptime; echo "$(date +%s) $up $(awk \'/^usage_usec/{print $2}\' /sys/fs/cgroup/cpu.stat) $(cat /sys/fs/cgroup/memory.current)"; sleep 1; done) >> /work/out/cgroup.log & while :; do sleep 3600; done';

/**
 * BSL-090 앞의 발생기 파드 그대로(loadtest/test/runner.test.mjs의 generatorPod 기대를 한 객체로 모은 것, env 차례 포함).
 * index가 없으면 generatorPod는 이 파드와 같아야 한다
 */
function podBefore({ name, cpus, memoryMi, simKey = false, deadlineS = 11400 }) {
  const res = { cpu: String(cpus), memory: `${memoryMi}Mi` };
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: 'loadtest', labels: { 'app.kubernetes.io/name': 'loadgen', 'app.kubernetes.io/part-of': 'peaket-loadtest' } },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      terminationGracePeriodSeconds: 5,
      activeDeadlineSeconds: deadlineS,
      nodeSelector: { 'kubernetes.io/hostname': 'peaket-control-plane' },
      securityContext: { runAsNonRoot: true, runAsUser: 12345, runAsGroup: 12345, fsGroup: 12345, seccompProfile: { type: 'RuntimeDefault' } },
      containers: [
        {
          name: 'k6',
          image: K6_IMAGE,
          imagePullPolicy: 'IfNotPresent',
          command: ['sh', '-c', SAMPLER_SCRIPT_BEFORE],
          env: [
            { name: 'GOMAXPROCS', value: String(cpus) },
            { name: 'K6_NO_USAGE_REPORT', value: 'true' },
            { name: 'SSL_CERT_FILE', value: '/work/ca.pem' },
            ...(simKey ? [{ name: 'PG_SIMULATOR_SECRET_KEY', valueFrom: { secretKeyRef: { name: 'loadgen-sim', key: 'PG_SIMULATOR_SECRET_KEY' } } }] : []),
          ],
          resources: { requests: { ...res }, limits: { ...res } },
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
          volumeMounts: [
            { name: 'work', mountPath: '/work' },
            { name: 'tmp', mountPath: '/tmp' },
          ],
        },
      ],
      volumes: [
        { name: 'work', hostPath: { path: HOST_DIR, type: 'Directory' } },
        { name: 'tmp', emptyDir: { sizeLimit: '64Mi' } },
      ],
    },
  };
}

// ---------------------------------------------------------------------------------------------
// samplerCommand
// ---------------------------------------------------------------------------------------------

test('BSL090_NFR-013_표본명령_/work/out이면_SAMPLER_COMMAND와_바이트까지같은_얼린세칸배열이고_하나일때의명령은바꾸기전그대로다', () => {
  const c = samplerCommand('/work/out');
  assert.ok(Array.isArray(c));
  assert.ok(Object.isFrozen(c), '얼린 배열');
  assert.equal(c.length, 3);
  assert.equal(c[0], 'sh');
  assert.equal(c[1], '-c');
  assert.equal(c[2], SAMPLER_COMMAND[2], 'SAMPLER_COMMAND와 바이트까지 같다');
  assert.deepStrictEqual([...c], [...SAMPLER_COMMAND]);
  assert.equal(samplerCommand('/work/out')[2], c[2], '부를 때마다 같은 글');
  // 함수로 바꾼 뒤에도 하나일 때의 표본 명령은 바꾸기 전 글 그대로다(results.mjs parseCgroupLog가 이 줄 꼴을 읽는다)
  assert.ok(Object.isFrozen(SAMPLER_COMMAND));
  assert.deepStrictEqual([...SAMPLER_COMMAND], ['sh', '-c', SAMPLER_SCRIPT_BEFORE]);
});

test('BSL090_NFR-013_나눈발생기_표본명령_/work/out/g<번호>면_그폴더를만들고_그폴더의cgroup.log에덧붙인다(나머지글은같다)', () => {
  const scripts = new Set();
  for (let i = 0; i <= 63; i++) {
    const outDir = `/work/out/g${i}`;
    const c = samplerCommand(outDir);
    assert.ok(Array.isArray(c) && Object.isFrozen(c), `${outDir}: 얼린 배열`);
    assert.equal(c.length, 3, outDir);
    assert.deepStrictEqual(c.slice(0, 2), ['sh', '-c'], outDir);
    // 표본 폴더만 바꾼 SAMPLER_COMMAND: '/work/out' 두 자리(만들 폴더, 덧붙일 파일)가 그 폴더로 바뀐다
    assert.equal(c[2], SAMPLER_COMMAND[2].replaceAll('/work/out', outDir), outDir);
    assert.ok(c[2].startsWith(`mkdir -p ${outDir}; `), `${outDir}: 그 폴더를 만든다`);
    assert.ok(c[2].includes(`>> ${outDir}/cgroup.log &`), `${outDir}: 그 폴더의 cgroup.log에 덧붙인다`);
    assert.ok(!c[2].includes('>> /work/out/cgroup.log'), `${outDir}: 하나일 때의 표본 파일에 쓰지 않는다`);
    scripts.add(c[2]);
  }
  assert.equal(scripts.size, 64, '발생기마다 다른 표본 파일');
});

test('BSL090_NFR-013_표본명령_outDir가_/work/out·/work/out/g0~g63이아니면_RangeError(셸글에들어가므로허용목록만) [ASVS v5.0.0-1.2.5]', () => {
  for (const outDir of [
    '/work/out/g64',
    '/work/out/g99',
    '/work/out/g100',
    '/work/out/g-1',
    '/work/out/g00', // 앞의 0(g0~g63만)
    '/work/out/g01',
    '/work/out/g007',
    '/work/out/g',
    '/work/out/',
    '/work/out/g1/',
    '/work/out//g1',
    '/work//out',
    '/work/out/G1',
    '/work/out/x1',
    '/work/out/g1x',
    '/work/out/g1.5',
    '/work/out/g+1',
    '/work/out/g 1',
    '/work/out/g1 ',
    ' /work/out',
    '/work/out ',
    '/work/out\n',
    '/work/out/g1\n',
    '/work/out/g1;id',
    '/work/out;id',
    '/work/out/g$(id)',
    '/work/out/g`id`',
    '/work/out && id',
    '/work/out/g1|id',
    '/work/out/g1>x',
    '/work/out/../etc',
    '/work/out/g1/..',
    // 앞에 붙은 글(허용 꼴이 끝에만 맞아도 셸 글이 된다)
    'x/work/out/g1',
    '/tmp/work/out/g1',
    ';id;/work/out/g1',
    '$(id)/work/out/g1',
    '/work/out/g1;/work/out/g1',
    '/work/outx',
    '/work/out2',
    '/work',
    '/tmp/out',
    'work/out',
    './work/out',
    '/WORK/OUT',
    '\\work\\out',
    '',
  ]) {
    assert.throws(() => samplerCommand(outDir), RangeError, show(outDir));
  }
});

test('BSL090_NFR-013_표본명령_outDir가글이아니면_RangeError(바른경로를담은배열·toString객체도) [ASVS v5.0.0-1.2.5]', () => {
  for (const outDir of [undefined, null, 0, 3, true, {}, [], ['/work/out'], ['/work/out/g1'], { toString: () => '/work/out/g1' }, new String('/work/out')]) {
    assert.throws(() => samplerCommand(outDir), RangeError, show(outDir));
  }
});

// ---------------------------------------------------------------------------------------------
// RUN_SCRIPT_SPLIT(글)
// ---------------------------------------------------------------------------------------------

test('BSL090_NFR-013_나눈발생기_실행스크립트는_고정글로_run-<GEN_INDEX>.env만내보내기변수로읽고_k6는하나일때인자에실행구간둘만더해돌린다 [ASVS v5.0.0-1.2.5]', () => {
  const s = splitScript();
  assert.ok(s.startsWith('#!/bin/sh\n'));
  assert.ok(s.endsWith('\n'));
  const at = (frag) => {
    const i = s.indexOf(frag);
    assert.ok(i >= 0, `빠짐: ${frag}`);
    return i;
  };
  const source = '. "/work/run-$GEN_INDEX.env"';
  assert.ok(at('set -a') < at(source) && at(source) < at('set +a') && at('set +a') < at('k6 run'), 'set -a → 읽기 → set +a → k6');
  assert.ok(at('cd /work') < at('k6 run'));
  assert.ok(at('/work/go') < at('k6 run'), '시작 파일을 본 뒤에 k6를 돌린다');
  assert.ok(!s.includes('/work/run.env'), '하나일 때의 run.env는 읽지 않는다');
  assert.equal([...s.matchAll(/^\s*\.\s/gm)].length, 1, '읽는 파일은 run-<번호>.env 하나');
  assert.doesNotMatch(s, /\beval\b/, '글을 다시 해석하지 않는다');
  const k6Lines = s.split('\n').filter((l) => /^\s*k6\b/.test(l));
  assert.equal(k6Lines.length, 1, 'k6는 한 번 돌린다');
  const [k6] = k6Lines;
  assert.ok(k6.includes('"loadtest/scenarios/$SCENARIO"'), '시나리오 경로는 따옴표로 감싼다');
  assert.match(k6, /--console-output=\S*console\.ndjson/);
  const single = RUN_SCRIPT.split('\n').find((l) => l.startsWith('k6 run'));
  const flags = (line) => line.split(/\s+/).filter((w) => w.startsWith('--') && !w.startsWith('--console-output='));
  assert.ok(flags(single).includes('--no-usage-report'), '기준: 하나일 때의 k6 인자를 읽었다');
  // k6는 실행 구간을 환경 값으로 읽지 않는다: 하나일 때 인자에 실행 구간 두 인자(값은 run-<번호>.env의 변수, 따옴표)만 더한다(2026-11-03 재현)
  assert.deepStrictEqual(flags(k6), [...flags(single), '--execution-segment', '--execution-segment-sequence'], 'k6 인자는 하나일 때 + 실행 구간 둘이다(콘솔 출력 경로만 다르다)');
  assert.ok(k6.includes('--execution-segment "$K6_EXECUTION_SEGMENT" --execution-segment-sequence "$K6_EXECUTION_SEGMENT_SEQUENCE"'), '실행 구간 값은 run-<번호>.env의 변수를 따옴표로 감싸 넘긴다');
});

test('BSL090_NFR-013_나눈발생기_실행스크립트·표본명령은_환경값(시험키)을로그에펼치지않는다(set -x·set·env·printenv 없음) [ASVS v5.0.0-16.2.5]', () => {
  const s = splitScript();
  for (const text of [s, samplerCommand('/work/out/g0')[2], samplerCommand('/work/out/g63')[2]]) {
    assert.doesNotMatch(text, /set\s+-[a-z]*x/);
    assert.doesNotMatch(text, /(^|[;&|(]\s*)(env|printenv)\b/m);
    assert.doesNotMatch(text, /(^|[;&|(]\s*)set\s*($|[;&|)])/m, '인자 없는 set은 모든 변수를 찍는다');
    assert.doesNotMatch(text, /\bexport\s+-p\b|environ/);
    assert.doesNotMatch(text, /PG_SIMULATOR_SECRET_KEY/);
  }
  // 실행 스크립트의 echo는 종료 코드(98·$?)만 쓴다: 읽은 환경 값을 펼쳐 쓰지 않는다
  const echoes = [...s.matchAll(/\becho\b([^;&|>\n]*)/g)];
  assert.ok(echoes.length > 0, '기준: 종료 코드를 echo로 쓴다');
  for (const m of echoes) assert.doesNotMatch(m[1].replaceAll('$?', ''), /\$/, `echo가 변수를 쓴다: ${m[0]}`);
});

// ---------------------------------------------------------------------------------------------
// RUN_SCRIPT_SPLIT(동작): 고정 k6 이미지의 셸로 돌린다
// ---------------------------------------------------------------------------------------------

/** Git Bash에서 띄워도 경로 인자를 바꾸지 않게 한다 */
const DOCKER_ENV = { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' };
function docker(args, timeout) {
  return execFileSync('docker', args, { encoding: 'utf8', env: DOCKER_ENV, timeout, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}
/** Docker 엔진에 닿는지. 닿지 않으면 그 까닭(건너뛰는 사유) */
function dockerProblem() {
  try {
    docker(['version', '--format', '{{.Server.Version}}'], 60_000);
    return '';
  } catch (e) {
    const why = e.code === 'ENOENT' ? 'docker 명령이 없다' : `docker version 실패(종료 코드 ${e.status ?? e.code}): ${String(e.stderr ?? '').trim().slice(0, 200)}`;
    return `Docker가 없어 나눈 발생기 실행 스크립트의 동작 시험을 건너뛴다: ${why}`;
  }
}
const SKIP = dockerProblem() || false;
/** Docker에 줄 호스트 경로(Windows는 \ → /) */
const hostPath = (p) => (process.platform === 'win32' ? p.replaceAll('\\', '/') : p);
/** K6_IMAGE의 PATH(다이제스트로 고정한 이미지라 바뀌지 않는다). 가짜 명령 폴더 /fake를 그 앞에 둔다 */
const IMAGE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * 가짜 k6: 부를 때마다 /work/k6-runs.txt에 GEN_INDEX 한 줄을 덧붙이고, 받은 인자·작업 폴더·환경 값과 시작할 때 자기 산출물 폴더(out/g$GEN_INDEX)에
 * 있던 파일을 /work/k6-call-<번호>.txt에 적고 종료 코드 7로 끝난다
 */
const FAKE_K6 = `#!/bin/sh
echo "$GEN_INDEX" >> /work/k6-runs.txt
o="/work/k6-call-$GEN_INDEX.txt"
for a in "$@"; do printf 'arg=%s\\n' "$a"; done > "$o"
printf 'pwd=%s\\n' "$(pwd)" >> "$o"
for v in FOO SCENARIO OUT_DIR K6_EXECUTION_SEGMENT K6_EXECUTION_SEGMENT_SEQUENCE; do printf 'env.%s=%s\\n' "$v" "$(printenv "$v")" >> "$o"; done
for f in exit exit.tmp console.ndjson summary.json k6.log started; do
  if [ -e "/work/out/g$GEN_INDEX/$f" ]; then printf 'at-start.%s=%s\\n' "$f" "$(cat "/work/out/g$GEN_INDEX/$f")" >> "$o"; fi
done
if [ -e /work/go ]; then echo 'go=yes' >> "$o"; fi
echo k6-stdout
echo k6-stderr >&2
exit 7
`;
/** 가짜 mv: 부른 인자와 그때 원본 파일의 글을 /work/mv-calls.txt에 덧붙이고 진짜 mv를 부른다 */
const FAKE_MV = `#!/bin/sh
printf '%s|%s|%s\\n' "$1" "$2" "$(cat "$1" 2>/dev/null)" >> /work/mv-calls.txt
exec /bin/mv "$@"
`;
/** 가짜 sleep: 받은 인자를 /work/sleeps.txt에 덧붙이고 진짜 sleep을 부른다 */
const FAKE_SLEEP = `#!/bin/sh
echo "$*" >> /work/sleeps.txt
exec /bin/sleep "$@"
`;

/**
 * 임시 작업 폴더(→ /work, run-split.sh를 bin/에 둔다)와 가짜 명령 폴더(→ /fake, 읽기 전용).
 * 시험이 끝나면 띄운 컨테이너(containers에 이름을 넣는다)를 먼저 지우고 폴더를 지운다
 */
function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'peaket-split-'));
  const containers = [];
  t.after(() => {
    for (const name of containers) {
      try {
        docker(['rm', '-f', name], 60_000);
      } catch {
        // 이미 없다
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  const work = join(root, 'work');
  const fake = join(root, 'fake');
  mkdirSync(join(work, 'bin'), { recursive: true });
  mkdirSync(fake);
  writeFileSync(join(work, 'bin', 'run-split.sh'), splitScript());
  for (const [name, body] of [['k6', FAKE_K6], ['mv', FAKE_MV], ['sleep', FAKE_SLEEP]]) writeFileSync(join(fake, name), body, { mode: 0o755 });
  const file = (rel) => join(work, ...rel.split('/'));
  return {
    work,
    fake,
    containers,
    put(rel, text) {
      mkdirSync(dirname(file(rel)), { recursive: true });
      writeFileSync(file(rel), text);
    },
    has: (rel) => existsSync(file(rel)),
    read: (rel) => (existsSync(file(rel)) ? readFileSync(file(rel), 'utf8') : null),
  };
}

/**
 * docker run의 인자(이미지 뒤의 명령 인자 rest). 파드처럼 망 없음·읽기 전용 루트·tmpfs /tmp·모든 권한 버림으로 돈다.
 * Linux 러너에서는 임시 폴더(mkdtemp, 0700)에 쓰도록 이 프로세스의 사용자로, 그 밖(Docker Desktop)에서는 이미지 사용자(12345)로 돈다
 */
function runArgs(ws, env, rest) {
  const user = typeof process.getuid === 'function' ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
  const e = Object.entries({ PATH: `/fake:${IMAGE_PATH}`, ...env }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return ['--network', 'none', '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', ...user, ...e,
    '--mount', `type=bind,source=${hostPath(ws.work)},target=/work`, '--mount', `type=bind,source=${hostPath(ws.fake)},target=/fake,readonly`,
    '--entrypoint', 'sh', K6_IMAGE, ...rest];
}

/**
 * docker run의 결과. 컨테이너 명령의 종료 코드가 0이 아니어도 던지지 않는다(시간 초과·신호는 던진다).
 * 실행 도구는 스크립트를 nohup으로 뒤에서 띄우고(loadtest/run.mjs) out/g<번호>/exit만 읽으므로 스크립트 자체의 종료 코드는 보지 않는다
 */
function dockerRun(args, timeout) {
  try {
    return { status: 0, stdout: docker(args, timeout), stderr: '' };
  } catch (e) {
    if (typeof e.status !== 'number') throw e;
    return { status: e.status, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
  }
}
/** cond가 참이 될 때까지 0.1초마다 본다(ms가 지나면 그만). 마지막 cond 값 */
async function until(cond, ms) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await delay(100);
  return cond();
}
/** 가짜 명령이 남기는 시험용 파일(스크립트의 산출물이 아니다) */
const isProbe = (p) => /^(k6-call-\d+|k6-runs|mv-calls|sleeps)\.txt$/.test(p);
/** 작업 폴더의 파일(/work 기준 빗금 경로 → 글) 가운데 keep(경로)가 참인 것 */
function snapshot(ws, keep) {
  const out = {};
  for (const e of readdirSync(ws.work, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const abs = join(e.parentPath, e.name);
    const p = relative(ws.work, abs).split(sep).join('/');
    if (keep(p)) out[p] = readFileSync(abs, 'utf8');
  }
  return out;
}
/** 발생기 index의 산출물 폴더 밖이고 시험용 파일이 아닌 것(스크립트가 바꾸지 말아야 할 것) */
const outsideOf = (index) => (p) => !p.startsWith(`out/g${index}/`) && !isProbe(p);
/**
 * 표본 명령(samplerCommand)이 파드 시작부터 같은 폴더의 cgroup.log에 덧붙이던 줄. 실행 스크립트는 이 파일을 지우거나 비우면 안 된다
 * (실행 도구가 끝난 뒤 읽고, 표본 명령은 >>로 연 파일에 계속 쓰므로 지우면 그 뒤 표본도 잃는다)
 */
const SAMPLES = '1793649471 81234.56 1000 2000\n1793649472 81235.56 2000 2100\n';

/** 경로를 /work 기준 상대 경로로(스크립트가 cd /work 뒤 상대 경로로 써도, 절대 경로로 써도 같게 본다) */
const rel = (p) => p.replace(/^\/work\//, '');
/** 가짜 mv가 적은 부름 [원본, 대상, 그때 원본 글] */
function mvCalls(ws) {
  return (ws.read('mv-calls.txt') ?? '').split('\n').filter(Boolean).map((l) => {
    const [from, to, body] = l.split('|');
    return [rel(from), rel(to), body];
  });
}
/** 가짜 k6가 적은 부름: 인자 목록과 그 밖의 '키=값' */
function k6Call(ws, index) {
  const text = ws.read(`k6-call-${index}.txt`);
  assert.ok(text !== null, 'k6를 돌렸다');
  const lines = text.split('\n').filter(Boolean);
  const args = lines.filter((l) => l.startsWith('arg=')).map((l) => l.slice(4));
  const kv = Object.fromEntries(lines.filter((l) => !l.startsWith('arg=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { args, kv };
}
/**
 * 하나일 때(RUN_SCRIPT)의 k6 인자에서 콘솔 출력만 out/g<번호>/로 옮기고, 시나리오 앞에 실행 구간 두 인자(값은 run-<번호>.env의 것)를 넣고,
 * 시나리오 자리에 scenario를 넣은 것. k6는 실행 구간을 환경 값으로 읽지 않으므로 명령줄 인자로 받아야 한다(아래 진짜 k6 재현 시험)
 */
function splitK6Args(index, scenario, segment, sequence) {
  const line = RUN_SCRIPT.split('\n').find((l) => l.startsWith('k6 run'));
  const words = line.slice(0, line.indexOf(' > ')).split(/\s+/).slice(1);
  const moved = words.map((w) => w.replace('--console-output=out/', `--console-output=out/g${index}/`));
  const at = moved.indexOf('"loadtest/scenarios/$SCENARIO"');
  assert.ok(at > 0, '하나일 때 인자의 끝은 시나리오다');
  return [...moved.slice(0, at), '--execution-segment', segment, '--execution-segment-sequence', sequence, `loadtest/scenarios/${scenario}`];
}

describe('BSL-090 나눈 발생기 실행 스크립트의 동작(고정 k6 이미지의 셸, 가짜 k6·mv·sleep)', { skip: SKIP, concurrency: false }, () => {
  before(() => {
    // 이미지가 없으면 먼저 받는다(CI 첫 실행). 다이제스트로 고정한 이미지만 쓴다
    try {
      docker(['image', 'inspect', '--format', '{{.Id}}', K6_IMAGE], 60_000);
    } catch {
      docker(['pull', '--quiet', K6_IMAGE], 600_000);
    }
  }, { timeout: 660_000 });

  test('BSL090_NFR-013_나눈발생기_실행스크립트는_/work/go를기다렸다가_자기run-<번호>.env로k6를돌리고_out/g<번호>에만쓴다', { timeout: 300_000 }, async (t) => {
    const ws = workspace(t);
    const segs = '0,1/4,2/4,3/4,1';
    ws.put('run-3.env', runEnvFile({ SCENARIO: 'fake.js', OUT_DIR: '/work/out/g3', K6_EXECUTION_SEGMENT: '3/4:1', K6_EXECUTION_SEGMENT_SEQUENCE: segs, FOO: 'bar-3' }));
    ws.put('run-2.env', runEnvFile({ SCENARIO: 'other.js', OUT_DIR: '/work/out/g2', K6_EXECUTION_SEGMENT: '2/4:3/4', K6_EXECUTION_SEGMENT_SEQUENCE: segs, FOO: 'bar-2' }));
    ws.put('run.env', runEnvFile({ SCENARIO: 'single.js', OUT_DIR: '/work/out', FOO: 'single' }));
    // 앞 실행이 남긴 이 발생기의 산출물(지워야 한다)과, 다른 발생기·하나일 때의 산출물(건드리지 않아야 한다)
    const STALE = ['exit', 'exit.tmp', 'console.ndjson', 'summary.json', 'k6.log'];
    for (const f of [...STALE, 'started']) ws.put(`out/g3/${f}`, 'stale\n');
    ws.put('out/g3/cgroup.log', SAMPLES);
    ws.put('out/g2/exit', 'other\n');
    ws.put('out/exit', 'single\n');
    const before = snapshot(ws, outsideOf(3));

    const name = `peaket-split-go-${process.pid}-${Date.now()}`;
    ws.containers.push(name);
    docker(['run', '-d', '--name', name, ...runArgs(ws, { GEN_INDEX: 3 }, ['/work/bin/run-split.sh'])], 120_000);

    // 앞 산출물을 모두 지웠으면 시작 파일을 기다리는 반복에 들어간 것이다(지우기는 기다리기 전에 한다. 파일 하나씩 지우므로 모두 볼 때까지 기다린다).
    // 시작 파일 없이 k6를 돌렸으면(k6.log·exit를 다시 만든다) 곧바로 그 까닭으로 실패한다
    await until(() => ws.has('k6-runs.txt') || STALE.every((f) => !ws.has(`out/g3/${f}`)), 60_000);
    assert.equal(ws.has('k6-runs.txt'), false, '시작 파일이 없으면 k6를 돌리지 않는다');
    for (const f of STALE) assert.equal(ws.has(`out/g3/${f}`), false, `시작 파일을 기다리기 전에 앞 실행의 ${f}를 지운다`);
    // 시작 파일을 보며 15번 잠든 것(가짜 sleep도 정말 0.1초씩 자므로 1.4초 넘게 기다림)을 본 뒤에 놓는다.
    // 고정 시간 대신 그 증거를 기다려 느린 PC·CI에서도 같은 것을 본다
    const slept = () => (ws.read('sleeps.txt') ?? '').split('\n').filter(Boolean).length;
    await until(() => slept() >= 15 || ws.has('k6-runs.txt') || ws.has('out/g3/exit'), 60_000);
    assert.equal(ws.has('k6-call-3.txt'), false, '시작 파일이 없으면 k6를 돌리지 않는다');
    assert.equal(ws.has('k6-runs.txt'), false, '시작 파일이 없으면 k6를 돌리지 않는다');
    assert.equal(ws.has('out/g3/exit'), false, '기다리는 동안 종료 코드가 없다');
    assert.ok(slept() >= 15, `시작 파일이 없는 동안 0.1초씩 잠들며 다시 본다(잠든 수 ${slept()})`);
    assert.ok(!ws.has('out/g3/started') || ws.read('out/g3/started') === 'stale\n', '시작 시각은 시작 파일을 본 뒤에 적는다');

    ws.put('go', '');
    docker(['wait', name], 120_000);

    // 종료 코드는 k6의 것이고, 다 쓴 exit.tmp를 exit로 이름 바꿔 넣는다(실행 도구가 반쯤 쓴 파일을 읽지 않게)
    assert.equal(ws.read('out/g3/exit')?.trim(), '7');
    assert.equal(ws.has('out/g3/exit.tmp'), false);
    assert.deepStrictEqual(mvCalls(ws), [['out/g3/exit.tmp', 'out/g3/exit', '7']]);
    // k6는 하나일 때와 같은 인자로, 콘솔 출력만 out/g3/로 돌린다. 환경은 run-3.env를 내보내기 변수로 읽은 것이다
    const { args, kv } = k6Call(ws, 3);
    const want = splitK6Args(3, 'fake.js', '3/4:1', segs);
    assert.ok(want.includes('--console-output=out/g3/console.ndjson') && want.at(-1) === 'loadtest/scenarios/fake.js', `기준 인자: ${want.join(' ')}`);
    assert.deepStrictEqual(args.map((a) => a.replace(/^--console-output=\/work\//, '--console-output=')), want);
    assert.equal(kv.pwd, '/work');
    assert.equal(kv['env.FOO'], 'bar-3', 'run-3.env를 읽었다(run.env·run-2.env가 아니다)');
    assert.equal(kv['env.SCENARIO'], 'fake.js');
    assert.equal(kv['env.OUT_DIR'], '/work/out/g3');
    assert.equal(kv['env.K6_EXECUTION_SEGMENT'], '3/4:1', '자기 실행 구간으로 돈다');
    assert.equal(kv['env.K6_EXECUTION_SEGMENT_SEQUENCE'], segs);
    assert.equal(kv.go, 'yes');
    // k6가 시작할 때 앞 산출물은 없고(k6.log는 이번 출력을 받으려 비어 있다), 시작 시각은 이번 것으로 이미 적혀 있다
    for (const f of ['exit', 'exit.tmp', 'console.ndjson', 'summary.json']) assert.equal(kv[`at-start.${f}`], undefined, `k6 시작 때 ${f}가 남아 있다`);
    assert.ok(kv['at-start.k6.log'] === undefined || kv['at-start.k6.log'] === '', 'k6 시작 때 k6.log는 비어 있다');
    assert.match(kv['at-start.started'] ?? '', /^\d{10}$/, 'k6를 돌리기 전에 시작 시각(유닉스 초)을 적는다');
    const started = Number(ws.read('out/g3/started'));
    assert.ok(Math.abs(started - Date.now() / 1000) < 86_400, `시작 시각은 이번 유닉스 초다: ${started}`);
    // k6의 표준 출력·오류는 out/g3/k6.log로. k6는 한 번만 돌린다
    assert.equal(ws.read('out/g3/k6.log'), 'k6-stdout\nk6-stderr\n');
    assert.equal(ws.read('k6-runs.txt'), '3\n', 'k6는 한 번 돌린다');
    // 표본 명령의 cgroup.log는 그대로(앞 산출물로 지우지 않는다)
    assert.equal(ws.read('out/g3/cgroup.log'), SAMPLES, '자기 폴더의 cgroup.log를 지우거나 비우지 않는다');
    // 다른 발생기와 하나일 때의 산출물은 그대로이고, 시작 파일은 남는다(같은 폴더를 붙인 다른 발생기도 그 파일로 시작한다)
    assert.equal(ws.read('out/g2/exit'), 'other\n');
    assert.equal(ws.read('out/exit'), 'single\n');
    assert.ok(ws.has('go'), '시작 파일을 지우지 않는다');
    assert.deepStrictEqual(snapshot(ws, outsideOf(3)), { ...before, go: '' }, '자기 폴더(out/g3) 밖에는 쓰지도 지우지도 않는다');
    // 시작 파일은 0.1초마다 본다
    const sleeps = (ws.read('sleeps.txt') ?? '').split('\n').filter(Boolean);
    assert.ok(sleeps.length >= 15, `기다리는 동안 시작 파일을 여러 번 봤다: ${sleeps.length}번`);
    assert.ok(sleeps.every((a) => a === '0.1'), `sleep 인자: ${[...new Set(sleeps)].join(',')}`);
  });

  test('BSL090_NFR-013_나눈발생기_실행스크립트는_시작파일을0.1초씩6000번(10분)봐도없으면_종료코드98을이름바꿔넣고_k6를돌리지않는다', { timeout: 300_000 }, (t) => {
    const ws = workspace(t);
    ws.put('run-7.env', runEnvFile({ SCENARIO: 'fake.js', OUT_DIR: '/work/out/g7', FOO: 'bar-7' }));
    ws.put('out/g7/exit', 'stale\n');
    ws.put('out/g7/summary.json', 'stale\n');
    ws.put('out/g7/cgroup.log', SAMPLES);
    const before = snapshot(ws, outsideOf(7));
    // 10분 기다리기를 바로 돌린다: sleep을 받은 인자만 /tmp/sleeps에 적는 셸 함수로 둔 셸에서 스크립트를 읽어 돌리고(sleep 6000번을 프로세스로
    // 띄우면 이 PC에서 30~40초 걸린다. k6·mv는 그대로 PATH의 가짜다), 끝날 때(스크립트의 exit) sleep 인자별 횟수를 낸다.
    // 스크립트 자체의 종료 코드는 보지 않는다(dockerRun)
    const sh = "sleep() { echo \"$*\" >> /tmp/sleeps; }; trap 'sort /tmp/sleeps | uniq -c' EXIT; . /work/bin/run-split.sh";
    const r = dockerRun(['run', '--rm', ...runArgs(ws, { GEN_INDEX: 7 }, ['-c', sh])], 280_000);
    const counts = Object.fromEntries(r.stdout.split('\n').filter((l) => l.trim()).map((l) => {
      const m = /^\s*(\d+)\s(.*)$/.exec(l);
      assert.ok(m, `횟수 줄이 아니다: ${l}`);
      return [m[2], Number(m[1])];
    }));
    assert.deepStrictEqual(counts, { '0.1': 6000 }, `0.1초씩 6000번(10분) 본다(컨테이너 종료 코드 ${r.status}, 오류 출력: ${r.stderr.slice(-300)})`);
    assert.equal(ws.read('out/g7/exit')?.trim(), '98');
    assert.equal(ws.has('out/g7/exit.tmp'), false);
    assert.deepStrictEqual(mvCalls(ws), [['out/g7/exit.tmp', 'out/g7/exit', '98']], '98도 exit.tmp에 다 쓴 뒤 이름을 바꿔 넣는다');
    assert.equal(ws.has('k6-call-7.txt'), false, 'k6를 돌리지 않는다');
    assert.equal(ws.has('k6-runs.txt'), false, 'k6를 돌리지 않는다');
    assert.equal(ws.has('out/g7/started'), false, '시작하지 않았으니 시작 시각이 없다');
    assert.equal(ws.has('out/g7/k6.log'), false);
    assert.equal(ws.has('out/g7/summary.json'), false, '앞 실행의 요약은 지운다');
    assert.equal(ws.read('out/g7/cgroup.log'), SAMPLES, '자기 폴더의 cgroup.log를 지우거나 비우지 않는다');
    assert.deepStrictEqual(snapshot(ws, outsideOf(7)), before, '자기 폴더(out/g7) 밖에는 쓰지도 지우지도 않는다(시작 파일을 스스로 만들지 않는다)');
  });

  test('BSL090_NFR-013_나눈발생기_실행스크립트는_시작파일이이미있으면_곧바로k6를돌리고_시작파일을지우지않는다(같은폴더의다른발생기도시작한다)', { timeout: 300_000 }, (t) => {
    // 실행 도구는 발생기마다 스크립트를 뒤에서 띄우고 1초 뒤 시작 파일을 한 번 놓는다(loadtest/run.mjs). 늦게 뜬 스크립트는 시작 파일이 이미 있을 때
    // 시작하고, 시작 파일은 같은 노드 폴더를 붙인 모든 발생기가 함께 본다. 그래서 앞 산출물을 지울 때도, 시작한 뒤에도 시작 파일을 지우면 안 된다
    const ws = workspace(t);
    ws.put('go', '');
    for (const i of [0, 1]) {
      ws.put(`run-${i}.env`, runEnvFile({ SCENARIO: `s${i}.js`, OUT_DIR: `/work/out/g${i}`, K6_EXECUTION_SEGMENT: ['0:1/2', '1/2:1'][i], K6_EXECUTION_SEGMENT_SEQUENCE: '0,1/2,1', FOO: `bar-${i}` }));
      ws.put(`out/g${i}/cgroup.log`, SAMPLES);
    }
    for (const i of [0, 1]) {
      const before = snapshot(ws, outsideOf(i));
      const name = `peaket-split-ready-${i}-${process.pid}-${Date.now()}`;
      ws.containers.push(name);
      // 스크립트 자체의 종료 코드는 보지 않는다(dockerRun, 실행 도구는 out/g<번호>/exit만 읽는다)
      const r = dockerRun(['run', '--rm', '--name', name, ...runArgs(ws, { GEN_INDEX: i }, ['/work/bin/run-split.sh'])], 120_000);
      const label = `발생기 ${i}`;
      assert.equal(ws.read(`out/g${i}/exit`)?.trim(), '7', `${label}: 시작 파일이 이미 있으면 k6를 돌린다(컨테이너 종료 코드 ${r.status}, 오류 출력: ${r.stderr.slice(-300)})`);
      const { args, kv } = k6Call(ws, i);
      assert.deepStrictEqual(args.map((a) => a.replace(/^--console-output=\/work\//, '--console-output=')), splitK6Args(i, `s${i}.js`, ['0:1/2', '1/2:1'][i], '0,1/2,1'), label);
      assert.equal(kv['env.FOO'], `bar-${i}`, `${label}: 자기 run-${i}.env를 읽었다`);
      assert.equal(kv.go, 'yes', label);
      assert.match(ws.read(`out/g${i}/started`) ?? '', /^\d{10}\n?$/, `${label}: 시작 시각`);
      assert.equal(ws.read(`out/g${i}/cgroup.log`), SAMPLES, `${label}: cgroup.log를 지우거나 비우지 않는다`);
      assert.ok(ws.has('go'), `${label}: 시작 파일을 지우지 않는다`);
      // 앞 발생기(0번)의 산출물도 자기 폴더 밖이다: 1번이 앞 산출물을 지울 때 0번 것을 건드리지 않는다
      assert.deepStrictEqual(snapshot(ws, outsideOf(i)), before, `${label}: 자기 폴더(out/g${i}) 밖에는 쓰지도 지우지도 않는다`);
    }
    assert.equal(ws.read('k6-runs.txt'), '0\n1\n', '발생기마다 k6를 한 번씩 돌렸다');
  });

  // 재현 시험(2026-11-03 BSL-090 리허설 e2e 1번): 발생기 둘이 각자 계획 전체(진입 300건씩, 조회 두 배)를 보냈다. k6는 실행 구간을
  // 환경 값 K6_EXECUTION_SEGMENT로 받지 않는다(옵션의 envconfig에서 빠져 있다). 그래서 진짜 k6로 스크립트 둘을 돌려 반복이 나뉘는지 본다
  test('BSL090_NFR-013_나눈발생기_진짜k6로_실행구간0:1/2·1/2:1인발생기둘이_도착률시나리오의반복을반씩겹치지않게나눠돈다', { timeout: 300_000 }, async (t) => {
    const ws = workspace(t);
    const seq = '0,1/2,1';
    ws.put('loadtest/scenarios/seg.js', [
      "import exec from 'k6/execution';",
      "export const options = { scenarios: { s: { executor: 'constant-arrival-rate', rate: 20, timeUnit: '1s', duration: '2s', preAllocatedVUs: 4, maxVUs: 8 } } };",
      'export default function () { console.log(JSON.stringify({ it: exec.scenario.iterationInTest })); }',
      '',
    ].join('\n'));
    const segs = ['0:1/2', '1/2:1'];
    segs.forEach((segment, i) => ws.put(`run-${i}.env`, runEnvFile({ SCENARIO: 'seg.js', OUT_DIR: `/work/out/g${i}`, K6_EXECUTION_SEGMENT: segment, K6_EXECUTION_SEGMENT_SEQUENCE: seq })));
    const names = segs.map((_, i) => `peaket-split-real-${i}-${process.pid}-${Date.now()}`);
    // 가짜 명령 폴더를 PATH에서 빼고 이미지의 진짜 k6로 돌린다
    names.forEach((name, i) => {
      ws.containers.push(name);
      docker(['run', '-d', '--name', name, ...runArgs(ws, { GEN_INDEX: i, PATH: IMAGE_PATH }, ['/work/bin/run-split.sh'])], 120_000);
    });
    ws.put('go', '');
    for (const name of names) docker(['wait', name], 180_000);
    const its = segs.map((_, i) => {
      assert.equal(ws.read(`out/g${i}/exit`)?.trim(), '0', `발생기 ${i}의 k6가 성공했다(k6.log: ${(ws.read(`out/g${i}/k6.log`) ?? '').slice(-600)})`);
      return (ws.read(`out/g${i}/console.ndjson`) ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l).it);
    });
    const all = its.flat();
    assert.equal(new Set(all).size, all.length, `두 발생기가 같은 반복을 겹쳐 돌지 않는다(발생기별 ${its.map((x) => x.length).join('·')}건)`);
    assert.ok(all.length >= 38 && all.length <= 42, `합친 반복 수는 하나로 돌 때(초당 20 × 2초 = 40)와 같다: ${all.length}`);
    for (const [i, x] of its.entries()) assert.ok(x.length >= 0.35 * all.length && x.length <= 0.65 * all.length, `발생기 ${i}는 절반 가까이 돈다: ${x.length}/${all.length}`);
  });
});

// ---------------------------------------------------------------------------------------------
// generatorPod(index)
// ---------------------------------------------------------------------------------------------

test('BSL090_NFR-013_발생기파드_index가없으면_바꾸기전파드그대로다(GEN_INDEX없음·표본은/work/out)', () => {
  // 바꾸기 전과 같아야 하는 회귀 시험이라 바꾸기 전 판에서도 통과한다
  assert.deepStrictEqual(gpod({ name: 'loadgen-r1', cpus: 4, memoryMi: 4096 }), podBefore({ name: 'loadgen-r1', cpus: 4, memoryMi: 4096 }));
  assert.deepStrictEqual(
    gpod({ name: 'loadgen-r1', cpus: 2, memoryMi: 1024, simKey: true, deadlineS: 1800 }),
    podBefore({ name: 'loadgen-r1', cpus: 2, memoryMi: 1024, simKey: true, deadlineS: 1800 }),
  );
  assert.deepStrictEqual(gpod({ name: 'loadgen-r1', cpus: 4, memoryMi: 4096, index: undefined }), podBefore({ name: 'loadgen-r1', cpus: 4, memoryMi: 4096 }), 'index: undefined는 주지 않은 것');
  // 실행 도구는 JSON.stringify한 글을 kubectl에 넘긴다(loadtest/run.mjs viaStdin): 키 차례까지 같은 글이다
  for (const o of [{ name: 'loadgen-r1', cpus: 4, memoryMi: 4096 }, { name: 'loadgen-r1', cpus: 2, memoryMi: 1024, simKey: true, deadlineS: 1800 }]) {
    assert.equal(JSON.stringify(gpod(o)), JSON.stringify(podBefore(o)), `kubectl에 넘기는 글이 바꾸기 전과 같다: ${JSON.stringify(o)}`);
  }
});

test('BSL090_NFR-013_나눈발생기파드_index를주면_env끝에GEN_INDEX를더하고_표본은/work/out/g<번호>이며_나머지는index없는파드와같다', () => {
  for (const [index, simKey] of [[0, false], [3, true], [10, false], [63, true]]) {
    const o = { name: `loadgen-r1-g${index}`, cpus: 2, memoryMi: 1024, simKey, deadlineS: 3000 };
    const label = `index=${index} simKey=${simKey}`;
    const base = gpod(o);
    const split = gpod({ ...o, index });
    const c = split.spec.containers[0];
    assert.deepStrictEqual(c.env.at(-1), { name: 'GEN_INDEX', value: String(index) }, `${label}: env 끝은 GEN_INDEX(글 값)`);
    assert.equal(c.env.filter((e) => e.name === 'GEN_INDEX').length, 1, label);
    assert.deepStrictEqual(c.env.slice(0, -1), base.spec.containers[0].env, `${label}: 그 앞의 env는 index 없는 파드와 같다(시험 키 포함)`);
    assert.deepStrictEqual([...c.command], [...samplerCommand(`/work/out/g${index}`)], `${label}: 표본은 자기 폴더의 cgroup.log에`);
    const strip = (pod) => {
      const p = structuredClone(pod);
      delete p.spec.containers[0].env;
      delete p.spec.containers[0].command;
      return p;
    };
    assert.deepStrictEqual(strip(split), strip(base), `${label}: env·명령 밖은 index 없는 파드와 같다`);
  }
});

test('BSL090_NFR-013_나눈발생기파드_index가0~63정수가아니면_RangeError [ASVS v5.0.0-2.2.1]', () => {
  for (const index of [0, 63]) assert.equal(envByName(gpod({ name: 'g', cpus: 1, memoryMi: 256, index }).spec.containers[0]).GEN_INDEX?.value, String(index), `기준: index=${index}는 받는다`);
  for (const index of [-1, 64, 100, 1.5, -0.5, NaN, Infinity, -Infinity, '0', '3', '', null, true, false, [], [3], {}]) {
    assert.throws(() => gpod({ name: 'g', cpus: 1, memoryMi: 256, index }), RangeError, `index=${show(index)}`);
  }
});

test('BSL090_NFR-013_나눈발생기파드도_토큰·서비스링크없음·루트아닌12345·seccomp·권한상승금지·읽기전용루트·모든권한버림·실행폴더하나 [ASVS v5.0.0-13.2.2]', () => {
  const pod = gpod({ name: 'loadgen-r1-g5', cpus: 2, memoryMi: 1024, simKey: true, index: 5 });
  const c = pod.spec.containers[0];
  assert.equal(envByName(c).GEN_INDEX?.value, '5', '나눈 발생기 파드다');
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.enableServiceLinks, false);
  assert.deepStrictEqual(pod.spec.securityContext, { runAsNonRoot: true, runAsUser: K6_UID, runAsGroup: K6_UID, fsGroup: K6_UID, seccompProfile: { type: 'RuntimeDefault' } });
  assert.equal(pod.spec.containers.length, 1);
  assert.deepStrictEqual(c.securityContext, { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } });
  for (const k of ['hostNetwork', 'hostPID', 'hostIPC']) assert.notEqual(pod.spec[k], true, k);
  assert.deepStrictEqual(pod.spec.volumes.filter((v) => v.hostPath).map((v) => [v.name, v.hostPath.path, v.hostPath.type]), [['work', HOST_DIR, 'Directory']]);
  assert.ok(c.volumeMounts.every((m) => !m.subPath && !m.subPathExpr), 'hostPath를 subPath로 넓히지 않는다');
  assert.deepStrictEqual(pod.spec.nodeSelector, { 'kubernetes.io/hostname': KIND_NODE });
  // 시험 키는 Secret 참조로만 싣는다
  const key = envByName(c).PG_SIMULATOR_SECRET_KEY;
  assert.equal(Object.hasOwn(key, 'value'), false);
  assert.deepStrictEqual(key.valueFrom, { secretKeyRef: { name: SIM_KEY_SECRET, key: SIM_KEY_NAME } });
  assert.doesNotMatch(JSON.stringify(pod), /sim_sk_/);
});

// ---------------------------------------------------------------------------------------------
// runEnvFile(GEN_INDEX)
// ---------------------------------------------------------------------------------------------

test('BSL090_NFR-013_나눈발생기_run-<번호>.env가GEN_INDEX를덮으면_다른발생기폴더에쓰게되므로_runEnvFile은GEN_INDEX를거부한다 [ASVS v5.0.0-1.2.5]', () => {
  // 기준: 나눈 발생기의 env 파일에 실행 도구가 넣는 값과 BSL-090 시나리오가 읽는 이름, GEN_INDEX와 이름만 비슷한 키는 받는다
  const ok = {
    SCENARIO: 'v0-seat-hold.js',
    OUT_DIR: '/work/out/g3',
    K6_EXECUTION_SEGMENT: '3/4:1',
    K6_EXECUTION_SEGMENT_SEQUENCE: '0,1/4,2/4,3/4,1',
    LISTENERS: 5000,
    CONNECT_S: 20,
    KEEP: 1,
    SCANNERS: 10,
    TICKETS: 1802,
    CODES_FILE: '/work/codes.json',
    SCAN_TIMEOUT: '3s',
    FAULT_DROP_PCT: 5,
    FAULT_DELAY_PCT: 2,
    FAULT_DELAY_MS: 16000,
    GEN_INDEXX: 1,
    XGEN_INDEX: 1,
    GEN_INDE: 1,
    GEN_INDEX_1: 1,
  };
  assert.equal(runEnvFile(ok), Object.entries(ok).map(([k, v]) => `${k}=${v}\n`).join(''));
  for (const v of [0, 3, 63, '3', '', 'x']) {
    assert.throws(() => runEnvFile({ SCENARIO: 'v0-queue.js', GEN_INDEX: v }), Error, `GEN_INDEX=${show(v)}(뒤)`);
    assert.throws(() => runEnvFile({ GEN_INDEX: v, SCENARIO: 'v0-queue.js' }), Error, `GEN_INDEX=${show(v)}(앞)`);
  }
  // 나눈 발생기 파드가 env로 정하는 이름 전부(시험 키·GEN_INDEX 포함)를 거부한다
  const podEnv = gpod({ name: 'g', cpus: 2, memoryMi: 1024, simKey: true, index: 0 }).spec.containers[0].env.map((e) => e.name);
  assert.deepStrictEqual([...podEnv].sort(), ['GEN_INDEX', 'GOMAXPROCS', 'K6_NO_USAGE_REPORT', 'PG_SIMULATOR_SECRET_KEY', 'SSL_CERT_FILE']);
  for (const k of podEnv) assert.throws(() => runEnvFile({ SCENARIO: 'v0-queue.js', [k]: '1' }), Error, k);
});

// ---------------------------------------------------------------------------------------------
// deltaClientPod(K4)
// ---------------------------------------------------------------------------------------------

const UUID = '0b5a3f9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
/** 실행 도구가 주는 꼴의 바른 입력(받는 파드 0번, 연결 0~499) */
const DELTA = Object.freeze({
  name: 'loadgen-r1-l0',
  index: 0,
  cpus: 1,
  memoryMi: 512,
  hostDir: HOST_DIR,
  deadlineS: 3600,
  connsFrom: 0,
  connsTo: 500,
  gateway: 'wss://v0-gateway.v0.svc.cluster.local:8443',
  eventId: UUID,
  origin: 'https://127.0.0.1:8443',
  image: 'peaket/v0-monolith:local',
});
const dpod = (o = {}) => deltaClientPod({ ...DELTA, ...o });

/** JSDoc대로의 변경분 받는 파드. 꼬리표는 발생기와 같은 묶음(part-of)에 이름만 loadgen-delta(실행 도구의 정리가 이 이름으로 고른다) */
function deltaExpected(o) {
  const gen = gpod({ name: 'g', cpus: 1, memoryMi: 256 });
  const res = { cpu: String(o.cpus), memory: `${o.memoryMi}Mi` };
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: o.name, namespace: LOADGEN_NAMESPACE, labels: { ...gen.metadata.labels, 'app.kubernetes.io/name': 'loadgen-delta' } },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      terminationGracePeriodSeconds: 5,
      activeDeadlineSeconds: o.deadlineS,
      nodeSelector: { 'kubernetes.io/hostname': KIND_NODE },
      securityContext: gen.spec.securityContext,
      containers: [
        {
          name: 'client',
          image: o.image,
          imagePullPolicy: 'Never',
          command: ['node', '/work/loadtest/runner/delta-client.mjs'],
          env: [
            { name: 'CLIENT_INDEX', value: String(o.index) },
            { name: 'CONNS_FROM', value: String(o.connsFrom) },
            { name: 'CONNS_TO', value: String(o.connsTo) },
            { name: 'GATEWAY', value: o.gateway },
            { name: 'EVENT_ID', value: o.eventId },
            { name: 'ORIGIN', value: o.origin },
            { name: 'DEADLINE_S', value: String(o.deadlineS) },
          ],
          resources: { requests: { ...res }, limits: { ...res } },
          securityContext: gen.spec.containers[0].securityContext,
          volumeMounts: [
            { name: 'work', mountPath: '/work' },
            { name: 'tmp', mountPath: '/tmp' },
          ],
        },
      ],
      volumes: [
        { name: 'work', hostPath: { path: o.hostDir, type: 'Directory' } },
        { name: 'tmp', emptyDir: { sizeLimit: '64Mi' } },
      ],
    },
  };
}

test('BSL090_K4_S-T12_변경분받는파드_JSDoc그대로다(꼬리표·재시작·실행시간상한·노드·이미지·명령·env글값·요청=한도·볼륨)', () => {
  const other = {
    ...DELTA,
    name: 'loadgen-abcdefghij012345-l9',
    index: 9,
    cpus: 2,
    memoryMi: 1024,
    hostDir: `${NODE_ROOT}/abcdefghij012345`,
    deadlineS: 11400,
    connsFrom: 4500,
    connsTo: 5000,
    gateway: 'wss://v0-gateway.v0-base.svc.cluster.local:8443',
    eventId: '00000000-0000-4000-8000-000000000000',
    origin: 'https://localhost:8443',
    image: 'peaket/v0-monolith:base',
  };
  for (const o of [DELTA, other]) {
    const pod = deltaClientPod({ ...o });
    assert.deepStrictEqual(canon(pod), canon(deltaExpected(o)), o.name);
    const c = pod.spec.containers[0];
    assert.equal(c.env.length, 7, `${o.name}: env는 일곱(겹침 없음)`);
    for (const e of c.env) {
      assert.equal(typeof e.value, 'string', `${o.name}: ${e.name} 값은 글`);
      assert.deepStrictEqual(Object.keys(e).sort(), ['name', 'value'], `${o.name}: ${e.name}는 글 값으로만 싣는다`);
    }
    assert.equal(pod.metadata.labels['app.kubernetes.io/name'], 'loadgen-delta', '실행 도구가 정리할 때 고르는 이름');
    assert.equal(envMap(pod).DEADLINE_S, String(pod.spec.activeDeadlineSeconds), '클라이언트도 같은 시간에 스스로 끝난다');
  }
});

test('BSL090_K4_S-T12_변경분받는파드_최소권한:토큰·서비스링크없음·발생기와같은파드·컨테이너보안설정·실행폴더하나·비밀없음 [ASVS v5.0.0-13.2.2]', () => {
  const pod = dpod();
  const gen = gpod({ name: 'g', cpus: 1, memoryMi: 256 });
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.enableServiceLinks, false);
  assert.deepStrictEqual(pod.spec.securityContext, gen.spec.securityContext, '파드 보안 설정은 발생기와 같다');
  assert.deepStrictEqual(pod.spec.securityContext, { runAsNonRoot: true, runAsUser: K6_UID, runAsGroup: K6_UID, fsGroup: K6_UID, seccompProfile: { type: 'RuntimeDefault' } });
  assert.equal(pod.spec.containers.length, 1);
  const c = pod.spec.containers[0];
  assert.deepStrictEqual(c.securityContext, gen.spec.containers[0].securityContext, '컨테이너 보안 설정은 발생기와 같다');
  assert.deepStrictEqual(c.securityContext, { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } });
  for (const k of ['hostNetwork', 'hostPID', 'hostIPC', 'shareProcessNamespace']) assert.notEqual(pod.spec[k], true, k);
  assert.deepStrictEqual(pod.spec.volumes.filter((v) => v.hostPath).map((v) => [v.name, v.hostPath.path, v.hostPath.type]), [['work', HOST_DIR, 'Directory']], 'hostPath는 그 실행 폴더 하나');
  assert.ok(c.volumeMounts.every((m) => !m.subPath && !m.subPathExpr), 'hostPath를 subPath로 넓히지 않는다');
  assert.deepStrictEqual(pod.spec.nodeSelector, { 'kubernetes.io/hostname': KIND_NODE });
  // 비밀이 필요 없다: 토큰은 실행 폴더의 users.json에서 읽고, Secret 참조·시험 키를 싣지 않는다
  assert.doesNotMatch(JSON.stringify(pod), /secretKeyRef|"secret"|PG_SIMULATOR_SECRET_KEY|sim_sk_/);
  assert.ok(c.env.every((e) => !Object.hasOwn(e, 'valueFrom')));
  // env는 JSDoc의 일곱뿐이다: 발생기 파드의 시험 키 선택(simKey)을 함께 넘겨도 시험 키를 싣지 않는다
  assert.deepStrictEqual(deltaClientPod({ ...DELTA, simKey: true }), pod, 'simKey를 줘도 같은 파드');
});

test('BSL090_K4_S-T12_변경분받는파드_이름·번호·CPU·메모리·실행폴더·실행시간상한이규칙밖이면_RangeError [ASVS v5.0.0-2.2.1]', () => {
  // 경계 안은 받는다
  for (const name of ['a', '0', 'loadgen-r1-l0', `a${'b'.repeat(40)}c`]) assert.equal(dpod({ name }).metadata.name, name);
  for (const index of [0, 1, 63]) assert.equal(envMap(dpod({ index })).CLIENT_INDEX, String(index));
  for (const [cpus, memoryMi] of [[1, 256], [16, 32768]]) {
    const res = { cpu: String(cpus), memory: `${memoryMi}Mi` };
    assert.deepStrictEqual(dpod({ cpus, memoryMi }).spec.containers[0].resources, { requests: res, limits: res }, `cpus=${cpus} memoryMi=${memoryMi}: 요청 = 한도`);
  }
  for (const tag of ['a', '0', 'abcdefghij012345']) {
    const hostDir = `${NODE_ROOT}/${tag}`;
    assert.equal(dpod({ hostDir }).spec.volumes.find((v) => v.name === 'work').hostPath.path, hostDir);
  }
  for (const deadlineS of [60, 11400]) {
    const pod = dpod({ deadlineS });
    assert.equal(pod.spec.activeDeadlineSeconds, deadlineS);
    assert.equal(envMap(pod).DEADLINE_S, String(deadlineS));
  }
  // 밖은 거절한다
  const bad = {
    name: ['', 'A', 'Loadgen', '-a', 'a-', 'a_b', 'a.b', 'a b', `a${'b'.repeat(41)}c`, 'l0\n', '../x', undefined, null, 5],
    index: [-1, 64, 100, 1.5, NaN, Infinity, '0', '', null, undefined, true],
    cpus: [0, 17, 1.5, -1, NaN, Infinity, '1', null, undefined],
    memoryMi: [255, 32769, 256.5, 0, NaN, '512', null, undefined],
    hostDir: [
      undefined,
      null,
      '',
      42,
      [HOST_DIR],
      NODE_ROOT,
      `${NODE_ROOT}/`,
      `${NODE_ROOT}/r1/`,
      `${NODE_ROOT}/ABC`,
      `${NODE_ROOT}/abcdefghij0123456`,
      `${NODE_ROOT}/..`,
      `${NODE_ROOT}/../etc`,
      `${NODE_ROOT}/r1/out`,
      `${NODE_ROOT}//r1`,
      `${NODE_ROOT}/r-1`,
      `${NODE_ROOT}/r1\n`,
      `${NODE_ROOT}x/r1`,
      `${NODE_ROOT}\\r1`,
      '/etc',
      '/',
      'r1',
    ],
    // 발생기 파드와 달리 기본값이 없다(@param의 deadlineS는 생략할 수 없고, 클라이언트가 같은 시간에 스스로 끝나는 DEADLINE_S가 된다)
    deadlineS: [59, 11401, 0, -60, 600.5, NaN, Infinity, '600', null, undefined, true],
  };
  for (const [k, values] of Object.entries(bad)) {
    for (const v of values) assert.throws(() => dpod({ [k]: v }), RangeError, `${k}=${show(v)}`);
  }
  for (const o of [undefined, null, {}]) assert.throws(() => deltaClientPod(o), RangeError, show(o));
});

test('BSL090_K4_S-T12_변경분받는파드_연결번호는0이상정수이고_connsFrom<connsTo여야한다(가상사용자131,072명까지) [ASVS v5.0.0-2.2.1]', () => {
  for (const [connsFrom, connsTo] of [[0, 1], [0, 500], [4500, 5000], [131071, 131072], [0, 131072]]) {
    const env = envMap(dpod({ connsFrom, connsTo }));
    assert.equal(env.CONNS_FROM, String(connsFrom));
    assert.equal(env.CONNS_TO, String(connsTo));
  }
  for (const [connsFrom, connsTo] of [
    [5, 5],
    [6, 5],
    [0, 0],
    [-1, 5],
    [1.5, 3],
    [0, 2.5],
    ['0', 5],
    [0, '5'],
    [NaN, 5],
    [0, NaN],
    [0, Infinity],
    [null, 5],
    [0, null],
    [undefined, 5],
    [0, undefined],
    [true, 5],
    [0, true],
    [0, 131073], // docs/verification.md §3.9: 가상 사용자(토큰)는 131,072명까지다
    [131072, 131073],
  ]) {
    assert.throws(() => dpod({ connsFrom, connsTo }), RangeError, `${show(connsFrom)}~${show(connsTo)}`);
  }
});

test('BSL090_K4_S-T12_변경분받는파드_입구는_wss://v0-gateway.(v0|v0-base).svc.cluster.local:8443만_받는다 [ASVS v5.0.0-2.2.1]', () => {
  for (const ns of ['v0', 'v0-base']) {
    const gateway = `wss://v0-gateway.${ns}.svc.cluster.local:8443`;
    assert.equal(envMap(dpod({ gateway })).GATEWAY, gateway);
  }
  for (const gateway of [
    'https://v0-gateway.v0.svc.cluster.local:8443', // WebSocket(wss)만
    'ws://v0-gateway.v0.svc.cluster.local:8443', // TLS 없는 연결
    'wss://v0-gateway.v0.svc.cluster.local',
    'wss://v0-gateway.v0.svc.cluster.local:443',
    'wss://v0-gateway.v0.svc.cluster.local:8443/',
    'wss://v0-gateway.v0.svc.cluster.local:8443/v0/events',
    'wss://v0-gateway.v0.svc.cluster.local:8443?x=1',
    'wss://v0-gateway.v1.svc.cluster.local:8443',
    'wss://v0-gateway.v0-base2.svc.cluster.local:8443',
    'wss://v0-gateway.loadtest.svc.cluster.local:8443',
    'wss://null-target.loadtest.svc.cluster.local:8443',
    'wss://v0-gatewayxv0.svc.cluster.local:8443', // 점은 글자 그대로
    'wss://v0-gateway.v0xsvc.cluster.local:8443',
    'wss://v0-gateway.v0.svc.cluster.localx:8443',
    'wss://v0-gateway.v0:8443',
    'wss://user@v0-gateway.v0.svc.cluster.local:8443',
    'wss://evil.example/v0-gateway.v0.svc.cluster.local:8443',
    'wss://v0-gateway.v0.svc.cluster.local:8443.evil.example',
    'WSS://v0-gateway.v0.svc.cluster.local:8443',
    ' wss://v0-gateway.v0.svc.cluster.local:8443',
    'wss://v0-gateway.v0.svc.cluster.local:8443\n',
    'wss://127.0.0.1:8443',
    '',
    undefined,
    null,
    8443,
  ]) {
    assert.throws(() => dpod({ gateway }), RangeError, show(gateway));
  }
});

test('BSL090_K4_S-T12_변경분받는파드_회차ID는UUID·출처는https출처·이미지는peaket/v0-monolith:<태그>만_받는다(주소·헤더에들어가므로) [ASVS v5.0.0-2.2.1]', () => {
  for (const eventId of [UUID, '00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-4fff-bfff-ffffffffffff']) assert.equal(envMap(dpod({ eventId })).EVENT_ID, eventId);
  for (const eventId of ['', 'not-a-uuid', UUID.replaceAll('-', ''), `{${UUID}}`, `urn:uuid:${UUID}`, UUID.slice(0, -1), `${UUID}0`, `${UUID}\n`, ` ${UUID}`,
    UUID.replace('0b5a', '0g5a'), `${UUID}/../x`, '0b5a3f9e-1c2d-4e5f-8a9b_0c1d2e3f4a5b', undefined, null, 42]) {
    assert.throws(() => dpod({ eventId }), RangeError, `eventId=${show(eventId)}`);
  }
  for (const origin of ['https://127.0.0.1:8443', 'https://localhost:8443', 'https://peaket.local', 'https://a']) assert.equal(envMap(dpod({ origin })).ORIGIN, origin);
  for (const origin of ['http://127.0.0.1:8443', 'wss://127.0.0.1:8443', 'https://', 'https://127.0.0.1:8443/', 'https://127.0.0.1:8443/x', 'https://127.0.0.1:',
    'https://127.0.0.1:123456', 'https://user@127.0.0.1:8443', 'https://127.0.0.1:8443?x', 'https://127.0.0.1:8443#x', 'https://ho st',
    'https://a.example\r\nX-Evil: 1', 'https://127.0.0.1:8443\n', ' https://127.0.0.1:8443', 'null', '', undefined, null]) {
    assert.throws(() => dpod({ origin }), RangeError, `origin=${show(origin)}`);
  }
  for (const image of ['peaket/v0-monolith:local', 'peaket/v0-monolith:base', 'peaket/v0-monolith:v1.2.3_rc-1']) assert.equal(dpod({ image }).spec.containers[0].image, image);
  for (const image of ['peaket/v0-monolith', 'peaket/v0-monolith:', `peaket/v0-monolith@sha256:${'a'.repeat(64)}`, `peaket/v0-monolith:local@sha256:${'a'.repeat(64)}`,
    'peaket/pg-simulator:local', K6_IMAGE, 'docker.io/peaket/v0-monolith:local', 'evil/v0-monolith:local', 'peaket/v0-monolith-x:local', 'Peaket/v0-monolith:local',
    'peaket/v0-monolith:lo cal', 'peaket/v0-monolith:local ', 'peaket/v0-monolith:local\n', 'peaket/v0-monolith:a/b', 'peaket/v0-monolith:a:b', '', undefined, null]) {
    assert.throws(() => dpod({ image }), RangeError, `image=${show(image)}`);
  }
});
