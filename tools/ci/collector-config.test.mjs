// 수집기 2단 설정 생성기·정적 검사 시험(V-T49 ①②, BUILD_ORDER F-01-3 OPS-060, 계획 docs/review/plans/F-01-3.md §5·§6).
// 정본: docs/observability.md §1 '설정 원천과 로컬 확인'(검사 항목), §2 '신호 연결'(자원 속성 다섯), §6 '테일 기반 적응형 샘플링'(크기 처음 값),
// §7 '2차 마스킹 정규식 원천', docs/api/guidelines.md '드문 경로 표시 x-peaket-trace-rare', docs/verification.md V-T49 ①②.
// 두 길로 본다: 모듈(rareRoutes·generatedFiles·checkCollectorConfig)과 CLI(node tools/ci/collector-config.mjs --check|--write [--root <저장소>]).
// 임시 저장소에는 수집기 폴더·openapi·원천 JSON·observability.md를 복사하고, 규칙을 하나씩 깬다.
// 단언 값(크기·자원 속성·한도·표시)은 코드 상수가 아니라 정본 문서에서 읽는다.
// 시험이 정한 약속(계획 §5가 정하지 않은 것. 바꾸려면 계획 파일 '시험 이의'에 적는다):
//   - 막음 줄은 깬 규칙마다 하나다. 생성 파일(generated/)을 손으로 바꿔 규칙을 깨면 '생성 파일이 생성 결과와 다름'과 그 규칙 위반으로 둘이다.
//   - 손 파일(agent·gateway·cluster.yaml)의 위반 줄에는 그 파일 이름이 든다.
//   - 규칙을 깨는 자리는 겹쳐 읽는 차례(게이트웨이: gateway.yaml → generated/tail-sampling.yaml → generated/pii-masking.yaml)에서 그 값을 마지막으로
//     정한 파일이다. 시험은 그 파일을 찾아 고친다(어느 파일에 둘지는 구현 몫).
// 실행(저장소 뿌리): node --test tools/ci/collector-config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseDocument, stringify } from 'yaml';
import { checkCollectorConfig, generatedFiles, rareRoutes } from './collector-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'collector-config.mjs');
const REPO = resolve(HERE, '..', '..');

const COL = 'deploy/platform/observability/collector';
const F = {
  agent: `${COL}/agent.yaml`,
  gateway: `${COL}/gateway.yaml`,
  cluster: `${COL}/cluster.yaml`,
  tail: `${COL}/generated/tail-sampling.yaml`,
  pii: `${COL}/generated/pii-masking.yaml`,
};
/** 운영 판 게이트웨이를 겹쳐 읽는 차례(observability.md §1) */
const GATEWAY_ORDER = [F.gateway, F.tail, F.pii];
const OPENAPI = 'docs/api/openapi.yaml';
const PII_SOURCE = 'packages/platform/src/pii-patterns.json';
const OBS = 'docs/observability.md';
const PII_PROCESSOR = 'transform/pii';
const TAIL_PROCESSOR = 'tail_sampling';
const METHOD_ATTR = 'http.request.method';

// ---- 정본 값(문서에서 읽는다) ----

const obsLines = readFileSync(join(REPO, OBS), 'utf8').split('\n');
const lineWith = (needle) => {
  const l = obsLines.find((x) => x.includes(needle));
  assert.ok(l, `observability.md에서 "${needle}" 줄을 찾지 못했다`);
  return l;
};
/** §2 '신호 연결'의 자원 속성 다섯 */
const RESOURCE_ATTRS = (() => {
  const row = lineWith('| 신호 연결(ADR-0076) |');
  const m = /같은 자원 속성\(([^)]*)\)/.exec(row);
  assert.ok(m, '신호 연결 행에서 자원 속성 목록을 찾지 못했다');
  return [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1]);
})();
/** §1 '게이트웨이 수집기의 꼬리 표본 정책은 다섯이다' 줄(§6의 처음 값과 판정 캐시·메모리 상한·드문 경로 한도) */
const SIZING = (() => {
  const row = lineWith('게이트웨이 수집기의 꼬리 표본 정책은 다섯이다');
  const num = (re, what) => {
    const m = re.exec(row);
    assert.ok(m, `§1 꼬리 표본 줄에서 ${what}을 찾지 못했다`);
    return m;
  };
  const man = (s) => Math.round(Number(s.replace(/,/g, '')) * 10_000);
  const rare = num(/경로마다 전체 초당 (\d+) span.*?복제 (\d+)으로 나눠/, '드문 경로 한도');
  return {
    decisionWaitSeconds: Number(num(/`decision_wait` (\d+)초/, 'decision_wait')[1]),
    numTraces: man(num(/`num_traces` ([\d.]+)만/, 'num_traces')[1]),
    expectedNewTracesPerSec: Number(num(/`expected_new_traces_per_sec` ([\d,]+)/, 'expected_new_traces_per_sec')[1].replace(/,/g, '')),
    sampledCacheSize: man(num(/`sampled_cache_size` ([\d.]+)만/, 'sampled_cache_size')[1]),
    limitPercentage: Number(num(/`limit_percentage` (\d+)/, 'limit_percentage')[1]),
    spikeLimitPercentage: Number(num(/`spike_limit_percentage` (\d+)/, 'spike_limit_percentage')[1]),
    rareSpansPerSecond: Number(rare[1]) / Number(rare[2]),
  };
})();

// ---- 도우미 ----

const readYaml = (root, rel) => parse(readFileSync(join(root, rel), 'utf8'));
const writeYaml = (root, rel, obj) => writeFileSync(join(root, rel), stringify(obj));
function editYaml(root, rel, fn) {
  const d = readYaml(root, rel);
  fn(d);
  writeYaml(root, rel, d);
}
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** 수집기가 설정 여럿을 겹쳐 읽는 방식: 표는 깊게 합치고, 목록과 값은 뒤 파일이 통째로 바꾼다 */
function deepMerge(a, b) {
  if (!isObj(a) || !isObj(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in a ? deepMerge(a[k], v) : v;
  return out;
}
const effective = (root, files) => files.map((f) => readYaml(root, f) ?? {}).reduce(deepMerge, {});
const getIn = (o, path) => path.reduce((x, k) => (x == null ? undefined : x[k]), o);
/** 그 값을 마지막으로 정한 파일 */
function lastDefining(root, files, path) {
  const hit = files.filter((f) => getIn(readYaml(root, f), path) !== undefined);
  assert.ok(hit.length > 0, `${path.join('.')}를 정한 파일이 없다(${files.join(', ')})`);
  return hit[hit.length - 1];
}
/** 이름이 prefix이거나 prefix/…인 열쇠. 수집기 0.165는 옛 이름(loadbalancing·k8sattributes·k8sobjects)을 밑줄 이름의 별칭으로 받으므로 둘 다 본다 */
const ALIASES = { loadbalancing: ['loadbalancing', 'load_balancing'], k8sattributes: ['k8sattributes', 'k8s_attributes'], k8sobjects: ['k8sobjects', 'k8s_objects'] };
const named = (obj, prefix) => {
  const names = ALIASES[prefix] ?? [prefix];
  return Object.keys(obj ?? {}).filter((k) => names.some((n) => k === n || k.startsWith(`${n}/`)));
};
const pipelinesOf = (cfg, signal) => named(cfg?.service?.pipelines, signal);

function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), 'collector-config-'));
  for (const rel of [COL, OPENAPI, PII_SOURCE, OBS]) {
    const dest = join(root, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(REPO, rel), dest, { recursive: true });
  }
  return root;
}
function withTemp(fn) {
  const root = tempRepo();
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function cli(...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: REPO });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  return { status: r.status, out, blocked: out.split('\n').filter((l) => l.startsWith('막음: ')) };
}
const check = (root) => cli('--check', '--root', root);
const write = (root) => cli('--write', '--root', root);

/** 규칙 하나를 깬 임시 저장소에서 --check 1, 막음 줄 수 = 깬 수(생성 파일이면 둘), 함수 결과도 같은 수 */
function assertBlocked(root, mutated, what) {
  const r = check(root);
  const expected = mutated.includes('/generated/') ? 2 : 1;
  assert.equal(r.status, 1, `${what}: --check 끝 코드\n${r.out}`);
  assert.equal(r.blocked.length, expected, `${what}: 막음 줄 수\n${r.out}`);
  if (expected === 1) assert.ok(r.blocked[0].includes(basename(mutated)), `${what}: 막음 줄에 ${basename(mutated)}가 없다\n${r.out}`);
  else assert.ok(r.blocked.some((l) => l.includes(basename(mutated))), `${what}: 막음 줄에 ${basename(mutated)}가 없다\n${r.out}`);
  assert.equal(checkCollectorConfig(root).length, expected, `${what}: checkCollectorConfig 위반 수`);
}

/** 어떤 객체 안에서 값이 target인 목록 항목(글이거나 tag_name·key·from이 target인 표)을 모두 지운다. 지운 수를 돌려준다 */
function removeDeep(node, target) {
  let n = 0;
  if (Array.isArray(node)) {
    for (let i = node.length - 1; i >= 0; i--) {
      const v = node[i];
      if (v === target || (isObj(v) && [v.tag_name, v.key, v.name].includes(target))) {
        node.splice(i, 1);
        n += 1;
      } else n += removeDeep(v, target);
    }
  } else if (isObj(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (v === target) {
        delete node[k];
        n += 1;
      } else n += removeDeep(v, target);
    }
  }
  return n;
}
/** 자체 지표 주소의 8888을 9999로 바꾼다(포트 숫자나 '…:8888' 글). 바꾼 수를 돌려준다 */
function moveMetricsPort(node) {
  let n = 0;
  if (Array.isArray(node)) node.forEach((v, i) => (typeof v === 'string' && v.endsWith(':8888') ? ((node[i] = v.replace(/:8888$/, ':9999')), (n += 1)) : (n += moveMetricsPort(v))));
  else if (isObj(node))
    for (const [k, v] of Object.entries(node)) {
      if (v === 8888 || v === '8888') {
        node[k] = 9999;
        n += 1;
      } else if (typeof v === 'string' && v.endsWith(':8888')) {
        node[k] = v.replace(/:8888$/, ':9999');
        n += 1;
      } else n += moveMetricsPort(v);
    }
  return n;
}
const policiesFile = (root) => lastDefining(root, GATEWAY_ORDER, ['processors', TAIL_PROCESSOR, 'policies']);
const policyNames = (root) => effective(root, GATEWAY_ORDER).processors[TAIL_PROCESSOR].policies.map((p) => p.name);

// ---- V-T49 ① 실제 저장소 ----

test('V-T49 ①-1 실제 저장소의 수집기 설정은 --check를 통과한다(끝 코드 0, 막음 줄 없음, 함수 결과 빈 배열)', () => {
  const r = check(REPO);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.blocked, []);
  assert.deepEqual(checkCollectorConfig(REPO), []);
  // 기본 뿌리(--root 없음)도 이 저장소다
  assert.equal(cli('--check').status, 0);
});

test('V-T49 ①-2 실제 에이전트 설정: 처리기 첫째가 메모리 상한, 추적 내보내기는 부하 분산(traceID, 쿠버네티스 해석기) 하나, 자원 속성 다섯', () => {
  assert.deepEqual(RESOURCE_ATTRS, ['service.name', 'deployment.environment', 'k8s.namespace.name', 'k8s.pod.name', 'k8s.node.name']);
  const cfg = readYaml(REPO, F.agent);
  const traces = pipelinesOf(cfg, 'traces');
  const logs = pipelinesOf(cfg, 'logs');
  assert.ok(traces.length > 0 && logs.length > 0, '에이전트에 추적·로그 파이프라인이 있다');
  for (const p of [...traces, ...logs]) assert.match(cfg.service.pipelines[p].processors[0], /^memory_limiter(\/|$)/, p);
  for (const p of traces) {
    const ex = cfg.service.pipelines[p].exporters;
    assert.equal(ex.length, 1, p);
    assert.match(ex[0], /^(loadbalancing|load_balancing)(\/|$)/, p);
    assert.equal(cfg.exporters[ex[0]].routing_key, 'traceID');
    assert.ok(isObj(cfg.exporters[ex[0]].resolver?.k8s), '운영 판 부하 분산은 쿠버네티스 해석기');
  }
  const k8s = named(cfg.processors, 'k8sattributes');
  assert.ok(k8s.length > 0, '쿠버네티스 메타데이터 처리기가 있다');
  const text = JSON.stringify(k8s.map((k) => cfg.processors[k]));
  for (const a of RESOURCE_ATTRS) assert.ok(text.includes(`"${a}"`), `쿠버네티스 메타데이터 처리기가 ${a}를 붙인다`);
});

test('V-T49 ①-3 실제 게이트웨이 설정(운영 판을 겹쳐 읽은 결과): 정책 다섯과 차례, 크기·판정 캐시·메모리 상한은 §1·§6의 값, 2차 마스킹이 추적·로그에', () => {
  const cfg = effective(REPO, GATEWAY_ORDER);
  const ts = cfg.processors[TAIL_PROCESSOR];
  assert.equal(String(ts.decision_wait), `${SIZING.decisionWaitSeconds}s`);
  assert.equal(Number(ts.num_traces), SIZING.numTraces);
  assert.equal(Number(ts.expected_new_traces_per_sec), SIZING.expectedNewTracesPerSec);
  assert.equal(Number(ts.decision_cache?.sampled_cache_size), SIZING.sampledCacheSize);
  assert.deepEqual([SIZING.numTraces, SIZING.sampledCacheSize, SIZING.decisionWaitSeconds, SIZING.expectedNewTracesPerSec], [35_000, 350_000, 10, 1_700]);
  const names = ts.policies.map((p) => p.name);
  const rare = names.filter((n) => n.startsWith('rare/'));
  assert.deepEqual(names, ['head', 'errors', 'slo-exceeded', ...rare, 'normal-keep']);
  assert.ok(rare.length > 0);
  const by = Object.fromEntries(ts.policies.map((p) => [p.name, p]));
  assert.equal(by.head.type, 'string_attribute');
  assert.deepEqual([by.head.string_attribute.key, by.head.string_attribute.values], ['peaket.sample.mode', ['head']]);
  assert.equal(by.errors.type, 'status_code');
  assert.deepEqual(by.errors.status_code.status_codes, ['ERROR']);
  assert.equal(by['slo-exceeded'].type, 'boolean_attribute');
  assert.deepEqual([by['slo-exceeded'].boolean_attribute.key, by['slo-exceeded'].boolean_attribute.value], ['peaket.slo.exceeded', true]);
  assert.equal(by['normal-keep'].type, 'boolean_attribute');
  assert.deepEqual([by['normal-keep'].boolean_attribute.key, by['normal-keep'].boolean_attribute.value], ['peaket.sample.keep', true]);
  assert.ok(!ts.policies.some((p) => p.type === 'probabilistic'));
  const ml = named(cfg.processors, 'memory_limiter');
  assert.ok(ml.length > 0);
  for (const k of ml) assert.deepEqual([cfg.processors[k].limit_percentage, cfg.processors[k].spike_limit_percentage], [SIZING.limitPercentage, SIZING.spikeLimitPercentage]);
  // 처리기 차례: 추적은 메모리 상한 → 꼬리 표본 → 2차 마스킹 → 묶기, 로그는 메모리 상한 → 2차 마스킹 → 묶기
  for (const p of pipelinesOf(cfg, 'traces')) {
    const pr = cfg.service.pipelines[p].processors;
    assert.match(pr[0], /^memory_limiter(\/|$)/, p);
    assert.deepEqual(pr.slice(1, 3), [TAIL_PROCESSOR, PII_PROCESSOR], p);
    assert.match(pr[pr.length - 1], /^batch(\/|$)/, p);
  }
  for (const p of pipelinesOf(cfg, 'logs')) {
    const pr = cfg.service.pipelines[p].processors;
    assert.match(pr[0], /^memory_limiter(\/|$)/, p);
    assert.equal(pr[1], PII_PROCESSOR, p);
    assert.match(pr[pr.length - 1], /^batch(\/|$)/, p);
  }
});

test('V-T49 ①-4 실제 클러스터 설정: k8sobjects는 리더 선출 확장에 묶이고, 셋 모두 자체 지표를 :8888에, 운영 판에 debug·zpages·pprof가 없다', () => {
  const cluster = readYaml(REPO, F.cluster);
  const objs = named(cluster.receivers, 'k8sobjects');
  assert.ok(objs.length > 0);
  for (const r of objs) {
    const elector = cluster.receivers[r].k8s_leader_elector;
    assert.ok(typeof elector === 'string' && named(cluster.extensions, 'k8s_leader_elector').includes(elector), r);
    assert.ok(cluster.service.extensions.includes(elector), r);
  }
  for (const [name, cfg] of [['agent', readYaml(REPO, F.agent)], ['gateway', effective(REPO, GATEWAY_ORDER)], ['cluster', cluster]]) {
    assert.ok(JSON.stringify(cfg.service?.telemetry?.metrics ?? {}).includes('8888'), `${name}: 자체 지표 :8888`);
    const used = [...Object.values(cfg.service.pipelines).flatMap((p) => p.exporters ?? []), ...(cfg.service.extensions ?? [])];
    assert.deepEqual(used.filter((x) => /^(debug|zpages|pprof)(\/|$)/.test(x)), [], name);
  }
});

// ---- V-T49 ① 규칙을 하나씩 깬다 ----

const tracesPipeline = (cfg) => cfg.service.pipelines[pipelinesOf(cfg, 'traces')[0]];
const logsPipeline = (cfg) => cfg.service.pipelines[pipelinesOf(cfg, 'logs')[0]];

const MUTATIONS = [
  {
    what: '에이전트 추적 파이프라인의 처리기 첫째가 메모리 상한이 아님',
    file: () => F.agent,
    edit: (cfg) => {
      const pr = tracesPipeline(cfg).processors;
      assert.match(pr[0], /^memory_limiter/);
      pr.push(pr.shift());
    },
  },
  {
    what: '에이전트 추적 내보내기가 부하 분산이 아님',
    file: () => F.agent,
    edit: (cfg) => {
      cfg.exporters['otlp/it'] = { endpoint: 'peaket-gw-0:4317' };
      tracesPipeline(cfg).exporters = ['otlp/it'];
    },
  },
  {
    what: '에이전트 부하 분산의 routing_key가 traceID가 아님',
    file: () => F.agent,
    edit: (cfg) => {
      const lb = named(cfg.exporters, 'loadbalancing');
      assert.ok(lb.length > 0);
      for (const k of lb) cfg.exporters[k].routing_key = 'service';
    },
  },
  {
    what: '에이전트 추적 내보내기가 둘',
    file: () => F.agent,
    edit: (cfg) => {
      cfg.exporters['otlp/it'] = { endpoint: 'peaket-gw-0:4317' };
      tracesPipeline(cfg).exporters.push('otlp/it');
    },
  },
  ...['service.name', 'deployment.environment', 'k8s.namespace.name', 'k8s.pod.name', 'k8s.node.name'].map((a) => ({
    what: `에이전트 쿠버네티스 메타데이터가 ${a}를 붙이지 않음`,
    file: () => F.agent,
    edit: (cfg) => {
      const n = named(cfg.processors, 'k8sattributes').reduce((k, p) => k + removeDeep(cfg.processors[p], a), 0);
      assert.ok(n > 0, `${a}를 지울 자리가 없다`);
    },
  })),
  {
    what: '게이트웨이에 probabilistic 정책',
    file: policiesFile,
    edit: (cfg) => cfg.processors[TAIL_PROCESSOR].policies.push({ name: 'it-probabilistic', type: 'probabilistic', probabilistic: { sampling_percentage: 10 } }),
  },
  ...['head', 'errors', 'slo-exceeded', 'rare/', 'normal-keep'].map((name) => ({
    what: `게이트웨이 정책 ${name} 빠짐`,
    file: policiesFile,
    edit: (cfg) => {
      const list = cfg.processors[TAIL_PROCESSOR].policies;
      const i = list.findIndex((p) => (name.endsWith('/') ? p.name.startsWith(name) : p.name === name));
      assert.ok(i >= 0, `${name} 정책이 없다`);
      list.splice(i, 1);
    },
  })),
  ...[
    ['decision_wait', `${SIZING.decisionWaitSeconds + 1}s`],
    ['num_traces', SIZING.numTraces + 1],
    ['expected_new_traces_per_sec', SIZING.expectedNewTracesPerSec + 1],
  ].map(([key, value]) => ({
    what: `게이트웨이 꼬리 표본 ${key}가 §6의 처음 값과 다름`,
    file: (root) => lastDefining(root, GATEWAY_ORDER, ['processors', TAIL_PROCESSOR, key]),
    edit: (cfg) => {
      cfg.processors[TAIL_PROCESSOR][key] = value;
    },
  })),
  ...['traces', 'logs'].map((signal) => ({
    what: `게이트웨이 ${signal} 파이프라인에 2차 마스킹 처리기가 없음`,
    file: (root) => lastDefining(root, GATEWAY_ORDER, ['service', 'pipelines', pipelinesOf(effective(root, GATEWAY_ORDER), signal)[0], 'processors']),
    edit: (cfg) => {
      const p = signal === 'traces' ? tracesPipeline(cfg) : logsPipeline(cfg);
      const i = p.processors.indexOf(PII_PROCESSOR);
      assert.ok(i >= 0);
      p.processors.splice(i, 1);
    },
  })),
  ...[
    ['에이전트', () => F.agent],
    ['게이트웨이', (root) => lastDefining(root, GATEWAY_ORDER, ['service', 'telemetry', 'metrics'])],
    ['클러스터', () => F.cluster],
  ].map(([who, file]) => ({
    what: `${who} 자체 지표 주소가 :8888이 아님`,
    file,
    edit: (cfg) => assert.ok(moveMetricsPort(cfg.service.telemetry.metrics) > 0, '8888을 바꿀 자리가 없다'),
  })),
  {
    what: '운영 판 에이전트에 debug 내보내기',
    file: () => F.agent,
    edit: (cfg) => {
      cfg.exporters.debug = {};
      logsPipeline(cfg).exporters.push('debug');
    },
  },
  {
    what: '운영 판 게이트웨이에 zpages 확장',
    file: () => F.gateway,
    edit: (cfg) => {
      cfg.extensions = { ...(cfg.extensions ?? {}), zpages: {} };
      cfg.service.extensions = [...(cfg.service.extensions ?? []), 'zpages'];
    },
  },
  {
    what: '운영 판 클러스터에 pprof 확장',
    file: () => F.cluster,
    edit: (cfg) => {
      cfg.extensions = { ...(cfg.extensions ?? {}), pprof: {} };
      cfg.service.extensions = [...(cfg.service.extensions ?? []), 'pprof'];
    },
  },
  {
    what: '클러스터 k8sobjects가 리더 선출에 묶이지 않음',
    file: () => F.cluster,
    edit: (cfg) => {
      const objs = named(cfg.receivers, 'k8sobjects');
      assert.ok(objs.length > 0);
      for (const r of objs) {
        assert.ok('k8s_leader_elector' in cfg.receivers[r]);
        delete cfg.receivers[r].k8s_leader_elector;
      }
    },
  },
];

for (const [i, m] of MUTATIONS.entries()) {
  test(`V-T49 ①-5.${i + 1} 규칙 하나를 깨면 막는다: ${m.what}`, () =>
    withTemp((root) => {
      const file = m.file(root);
      editYaml(root, file, m.edit);
      assertBlocked(root, file, m.what);
    }));
}

test('V-T49 ①-6 두 규칙을 깨면 막음 줄이 둘이다(깬 수만큼)', () =>
  withTemp((root) => {
    editYaml(root, F.agent, (cfg) => {
      const pr = tracesPipeline(cfg).processors;
      pr.push(pr.shift());
    });
    editYaml(root, F.cluster, (cfg) => {
      for (const r of named(cfg.receivers, 'k8sobjects')) delete cfg.receivers[r].k8s_leader_elector;
    });
    const r = check(root);
    assert.equal(r.status, 1, r.out);
    assert.equal(r.blocked.length, 2, r.out);
    assert.ok(r.blocked.some((l) => l.includes('agent.yaml')) && r.blocked.some((l) => l.includes('cluster.yaml')), r.out);
  }));

test('V-T49 ①-7 설정 파일을 읽지 못하면 통과로 보지 않는다(끝 코드 2)', () => {
  const cases = [
    ['에이전트 설정 지움', (root) => rmSync(join(root, F.agent))],
    ['클러스터 설정 지움', (root) => rmSync(join(root, F.cluster))],
    ['게이트웨이 설정 YAML 깨짐', (root) => writeFileSync(join(root, F.gateway), `${readFileSync(join(root, F.gateway), 'utf8')}\nservice: [\n  : : {\n`)],
    ['openapi 없음', (root) => rmSync(join(root, OPENAPI))],
    ['정규식 원천 없음', (root) => rmSync(join(root, PII_SOURCE))],
    ['정규식 원천 JSON 깨짐', (root) => writeFileSync(join(root, PII_SOURCE), '{"mask": "[REDACTED]", "patterns": [')],
  ];
  for (const [what, breakIt] of cases)
    withTemp((root) => {
      breakIt(root);
      const r = check(root);
      assert.equal(r.status, 2, `${what}: --check\n${r.out}`);
      if (what !== '에이전트 설정 지움' && what !== '클러스터 설정 지움' && what !== '게이트웨이 설정 YAML 깨짐') assert.equal(write(root).status, 2, `${what}: --write`);
    });
  assert.equal(cli('--check', '--bogus').status, 2);
  assert.equal(cli().status, 2);
  assert.equal(cli('--check', '--root').status, 2);
});

// ---- V-T49 ② 드문 경로와 생성 ----

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];
/** 시험이 따로 센 openapi의 드문 경로 표시(메서드 대문자, 경로 그대로) */
function rareFromOpenapi(text) {
  const out = [];
  for (const [route, item] of Object.entries(parse(text).paths ?? {}))
    for (const m of HTTP_METHODS) if (item?.[m]?.['x-peaket-trace-rare'] === true) out.push({ method: m.toUpperCase(), route });
  return out;
}

test('V-T49 ②-1 rareRoutes: 표시를 단 작업만, 메서드 대문자, 경로 그대로, 경로 → 메서드 차례(작은 openapi)', () => {
  const text = [
    'openapi: 3.1.0',
    'info: { title: t, version: "1" }',
    'paths:',
    '  /v1/b/{id}:',
    '    parameters: [{ name: id, in: path, required: true, schema: { type: string } }]',
    '    get: { operationId: getB, x-peaket-trace-rare: true, responses: { "200": { description: ok } } }',
    '    post: { operationId: createB, responses: { "200": { description: ok } } }',
    '  /v1/a:',
    '    put:',
    '      operationId: putA',
    '      x-peaket-trace-rare: false',
    '      responses: { "200": { description: ok } }',
    '    post:',
    '      operationId: createA',
    '      x-peaket-trace-rare: true',
    '      responses: { "200": { description: ok } }',
    '    delete: { operationId: deleteA, x-peaket-trace-rare: true, responses: { "204": { description: ok } } }',
    '',
  ].join('\n');
  assert.deepEqual(rareRoutes(text), [
    { method: 'DELETE', route: '/v1/a' },
    { method: 'POST', route: '/v1/a' },
    { method: 'GET', route: '/v1/b/{id}' },
  ]);
});

test('V-T49 ②-2 실제 openapi의 드문 경로는 시험이 센 표시와 같고 {param} 꼴이며, 생성 정책과 정확히 같다', () => {
  const text = readFileSync(join(REPO, OPENAPI), 'utf8');
  const want = rareFromOpenapi(text);
  assert.ok(want.length > 0);
  const got = rareRoutes(text);
  assert.equal(got.length, want.length);
  const key = (r) => `${r.method} ${r.route}`;
  assert.deepEqual(got.map(key).sort(), want.map(key).sort());
  for (const r of got) {
    assert.match(r.route, /^\/v1\//);
    assert.doesNotMatch(r.route, /:/, '경로 매개변수는 {param} 꼴(서버 span의 http.route)');
  }
  // 정산 지급 목록 조회(GET)는 표시가 없다(같은 경로의 POST만 드문 경로, guidelines.md)
  assert.ok(got.some((r) => key(r) === 'POST /v1/ops/payout-batches'));
  assert.ok(!got.some((r) => key(r) === 'GET /v1/ops/payout-batches'));
  // 생성된 정책: 경로마다 하나, 이름 rare/<메서드> <경로>, and(http.route 같음 + 메서드 같음 + rate_limiting 복제마다 한도)
  const cfg = effective(REPO, GATEWAY_ORDER);
  const rare = cfg.processors[TAIL_PROCESSOR].policies.filter((p) => p.name.startsWith('rare/'));
  assert.deepEqual(rare.map((p) => p.name).sort(), want.map((r) => `rare/${key(r)}`).sort());
  for (const p of rare) {
    const [method, route] = p.name.slice('rare/'.length).split(' ');
    assert.equal(p.type, 'and', p.name);
    const subs = p.and.and_sub_policy;
    const byType = (t) => subs.filter((s) => s.type === t);
    assert.deepEqual(
      byType('string_attribute').map((s) => [s.string_attribute.key, s.string_attribute.values]).sort(),
      [
        ['http.route', [route]],
        [METHOD_ATTR, [method]],
      ].sort(),
      p.name,
    );
    assert.deepEqual(byType('rate_limiting').map((s) => s.rate_limiting.spans_per_second), [SIZING.rareSpansPerSecond], p.name);
    assert.equal(subs.length, 3, p.name);
  }
});

test('V-T49 ②-3 generatedFiles는 generated/ 두 파일이고 저장소의 생성 파일과 같다', () => {
  const files = generatedFiles(REPO);
  assert.deepEqual([...files.keys()].sort(), [F.pii, F.tail].sort());
  for (const [rel, content] of files) assert.equal(readFileSync(join(REPO, rel), 'utf8'), content, rel);
});

/** openapi의 한 작업에 드문 경로 표시를 달거나(true) 뗀다(undefined) */
function setRare(root, route, method, on) {
  const doc = parseDocument(readFileSync(join(root, OPENAPI), 'utf8'));
  assert.ok(doc.getIn(['paths', route, method]), `${method} ${route}가 openapi에 없다`);
  if (on) doc.setIn(['paths', route, method, 'x-peaket-trace-rare'], true);
  else doc.deleteIn(['paths', route, method, 'x-peaket-trace-rare']);
  writeFileSync(join(root, OPENAPI), doc.toString());
}

test('V-T49 ②-4 openapi에 드문 경로 표시를 더하면 --check가 막고, --write 뒤 통과하며 그 정책이 생긴다', () =>
  withTemp((root) => {
    const before = policyNames(root);
    setRare(root, '/v1/ops/payout-batches', 'get', true);
    const r = check(root);
    assert.equal(r.status, 1, r.out);
    assert.equal(r.blocked.length, 1, r.out);
    assert.ok(r.blocked[0].includes('tail-sampling.yaml'), r.out);
    assert.equal(write(root).status, 0);
    assert.equal(check(root).status, 0, check(root).out);
    const after = policyNames(root);
    assert.ok(!before.includes('rare/GET /v1/ops/payout-batches'));
    assert.ok(after.includes('rare/GET /v1/ops/payout-batches'));
    assert.equal(after.length, before.length + 1);
  }));

test('V-T49 ②-5 openapi에서 드문 경로 표시를 빼면 --check가 막고, --write 뒤 통과하며 그 정책이 사라진다', () =>
  withTemp((root) => {
    const before = policyNames(root);
    assert.ok(before.includes('rare/POST /v1/ops/payout-batches'));
    setRare(root, '/v1/ops/payout-batches', 'post', false);
    const r = check(root);
    assert.equal(r.status, 1, r.out);
    assert.equal(r.blocked.length, 1, r.out);
    assert.ok(r.blocked[0].includes('tail-sampling.yaml'), r.out);
    assert.equal(write(root).status, 0);
    assert.equal(check(root).status, 0);
    const after = policyNames(root);
    assert.ok(!after.includes('rare/POST /v1/ops/payout-batches'));
    assert.ok(!after.includes('rare/GET /v1/ops/payout-batches'));
    assert.equal(after.length, before.length - 1);
  }));

test('V-T49 ②-6 정규식 원천의 꼴 하나를 바꾸면 pii-masking.yaml이 달라져 --check가 막고, --write 뒤 통과한다', () =>
  withTemp((root) => {
    const before = readFileSync(join(root, F.pii), 'utf8');
    const src = JSON.parse(readFileSync(join(root, PII_SOURCE), 'utf8'));
    const email = src.patterns.find((p) => p.name === 'email');
    assert.ok(email);
    email.pattern = `${email.pattern}|zz-it-marker`;
    writeFileSync(join(root, PII_SOURCE), `${JSON.stringify(src, null, 2)}\n`);
    const r = check(root);
    assert.equal(r.status, 1, r.out);
    assert.equal(r.blocked.length, 1, r.out);
    assert.ok(r.blocked[0].includes('pii-masking.yaml'), r.out);
    assert.equal(write(root).status, 0);
    assert.equal(check(root).status, 0);
    const after = readFileSync(join(root, F.pii), 'utf8');
    assert.notEqual(after, before);
    assert.ok(after.includes('zz-it-marker'));
    // 꼬리 표본 생성 파일은 그대로다
    assert.equal(readFileSync(join(root, F.tail), 'utf8'), readFileSync(join(REPO, F.tail), 'utf8'));
  }));

test('V-T49 ②-7 --write는 생성 파일이 없어도 만들고, 같은 입력이면 같은 내용을 쓴다', () =>
  withTemp((root) => {
    rmSync(join(root, COL, 'generated'), { recursive: true, force: true });
    assert.equal(write(root).status, 0);
    for (const rel of [F.tail, F.pii]) {
      assert.ok(existsSync(join(root, rel)), rel);
      assert.equal(readFileSync(join(root, rel), 'utf8'), readFileSync(join(REPO, rel), 'utf8'), rel);
    }
  }));
