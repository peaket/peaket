#!/usr/bin/env node
// 수집기 2단 설정 생성기·정적 검사(BUILD_ORDER F-01-3 OPS-060, docs/observability.md §1 '설정 원천과 로컬 확인', V-T49 ①②).
// 쓰는 법: node tools/ci/collector-config.mjs --write | --check [--root <저장소>]
//   --write  deploy/platform/observability/collector/generated/의 두 파일을 만든다
//            - tail-sampling.yaml: 꼬리 표본 처리기(tail_sampling). 크기 값은 docs/observability.md §1 '게이트웨이 수집기의 꼬리 표본 정책' 줄에서,
//              드문 경로 정책은 docs/api/openapi.yaml의 x-peaket-trace-rare: true를 단 작업에서 만든다
//            - pii-masking.yaml: 2차 마스킹 처리기(transform/pii). 꼴은 packages/platform/src/pii-patterns.json(§7 '2차 마스킹 정규식 원천')에서
//   --check  쓰지 않고 견주고, 운영 판 셋(agent·gateway·cluster.yaml, 게이트웨이는 생성 파일을 겹쳐 읽은 결과)이 §1의 규칙을 지키는지 본다
//   --root   저장소 뿌리(기본은 이 파일의 두 단계 위). 시험이 임시 저장소를 가리킬 때 쓴다
// 끝 코드: 0 통과·씀, 1 위반(모두 '막음: <파일>: <까닭>'으로 찍는다), 2 인자 오류·설정·openapi·원천을 읽지 못함
// 막음 줄은 깬 규칙마다 하나다. 생성 파일이 생성기 출력 그대로(머리의 본문 해시가 맞음)인데 원천과 다르면 '다시 만들라' 한 줄로 모은다.
// 생성 파일을 손으로 고쳤으면(해시가 맞지 않음) '생성 결과와 다름' 줄에 더해 그 내용이 깬 규칙도 따로 찍는다.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseDocument, stringify } from 'yaml';
import { runIfMain } from './entry.mjs';

const USAGE = '쓰는 법: node tools/ci/collector-config.mjs --write | --check [--root <저장소>]';
const COL = 'deploy/platform/observability/collector';
export const FILES = {
  agent: `${COL}/agent.yaml`,
  gateway: `${COL}/gateway.yaml`,
  cluster: `${COL}/cluster.yaml`,
  tail: `${COL}/generated/tail-sampling.yaml`,
  pii: `${COL}/generated/pii-masking.yaml`,
};
/** 운영 판 게이트웨이를 겹쳐 읽는 차례(observability.md §1). 로컬은 이 뒤에 local/gateway.yaml을 겹친다 */
export const GATEWAY_ORDER = [FILES.gateway, FILES.tail, FILES.pii];
const OPENAPI = 'docs/api/openapi.yaml';
const PII_SOURCE = 'packages/platform/src/pii-patterns.json';
const OBS = 'docs/observability.md';
const TAIL = 'tail_sampling';
const PII = 'transform/pii';
/** 게이트웨이가 자원 속성에서 복사하는 Loki 라벨(§1 Loki 줄·§7 라벨 허용 목록). 클러스터 이름만 환경 변수에서 온다 */
const LOKI_LABELS = 'transform/loki-labels';
const LOKI_LABEL_SOURCES = { namespace: 'k8s.namespace.name', service: 'service.name', env: 'deployment.environment' };
const CLUSTER_ENV = 'PEAKET_CLUSTER';
/** 서버 span이 싣는 HTTP 메서드 속성(지금 SDK의 이름, 계획 F-01-3 '시험 결과') */
const METHOD_ATTR = 'http.request.method';
/** 같은 문장을 몇 번 거는가(packages/platform/src/pii-text.ts의 PII_TEXT_PASSES와 같다. 붙은 두 값의 뒤쪽을 둘째 번에 잡는다) */
const PII_PASSES = 2;
/** IP를 담는 속성(§7) */
const IP_ATTRS = ['client.address', 'network.peer.address', 'source.address'];
/** 앞부분 꼴(그대로 둠: a.b.c.0/24, h:h:h::/48 — 서비스 템플릿의 ipPrefix와 같다)과 원문 IPv4(앞부분으로 바꿈) */
const IP_KEEP_OR_V4 = '^(([0-9]{1,3}[.]){3}0/24|([0-9a-fA-F]{1,4}(:[0-9a-fA-F]{1,4}){0,2})?::/48|([0-9]{1,3}[.]){3}[0-9]{1,3})$';
const IP_V4 = '^([0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3})[.][0-9]{1,3}$';
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];
/** 운영 판에 두지 않는 디버그 내보내기·진단 확장(§1) */
const DEBUG_TYPES = ['debug', 'zpages', 'pprof'];
/** 수집기 0.165는 옛 이름을 밑줄 이름의 별칭으로 받는다(옛 이름은 경고). 검사는 둘 다 받는다 */
const ALIASES = {
  load_balancing: ['load_balancing', 'loadbalancing'],
  k8s_attributes: ['k8s_attributes', 'k8sattributes'],
  k8s_objects: ['k8s_objects', 'k8sobjects'],
};
const HASH_LINE = /^# 본문 sha256: ([0-9a-f]{64})\n/m;

/** 읽기 실패(끝 코드 2) */
export class ReadError extends Error {}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const lf = (s) => s.replace(/\r\n/g, '\n');

function readText(root, rel) {
  const file = join(root, rel);
  if (!existsSync(file)) throw new ReadError(`${rel}이 없다`);
  return lf(readFileSync(file, 'utf8'));
}

function parseYaml(text, rel) {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new ReadError(`${rel}: YAML을 읽지 못했다: ${doc.errors[0].message.split('\n')[0]}`);
  const v = doc.toJS();
  return isObj(v) ? v : {};
}

/** 이름이 type이거나 type/…인 열쇠(별칭 포함) */
const typeOf = (name) => String(name).split('/')[0];
const isType = (name, type) => (ALIASES[type] ?? [type]).includes(typeOf(name));
const named = (obj, type) => Object.keys(obj ?? {}).filter((k) => isType(k, type));
const pipelinesOf = (cfg, signal) => Object.keys(cfg?.service?.pipelines ?? {}).filter((k) => typeOf(k) === signal);
const getIn = (o, path) => path.reduce((x, k) => (x == null ? undefined : x[k]), o);

/** 수집기가 설정 여럿을 겹쳐 읽는 방식: 표는 깊게 합치고, 목록과 값은 뒤 파일이 통째로 바꾼다 */
function deepMerge(a, b) {
  if (!isObj(a) || !isObj(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in a ? deepMerge(a[k], v) : v;
  return out;
}

// ---- 정본 값(문서에서 읽는다) ----

function obsLine(obsText, needle, what) {
  const l = obsText.split('\n').find((x) => x.includes(needle));
  if (!l) throw new ReadError(`${OBS}에서 ${what} 줄("${needle}")을 찾지 못했다`);
  return l;
}

/** §1 '게이트웨이 수집기의 꼬리 표본 정책은 다섯이다' 줄의 크기·한도 값 */
export function sizingFromDoc(obsText) {
  const row = obsLine(obsText, '게이트웨이 수집기의 꼬리 표본 정책은 다섯이다', '§1 꼬리 표본');
  const num = (re, what) => {
    const m = re.exec(row);
    if (!m) throw new ReadError(`${OBS} §1 꼬리 표본 줄에서 ${what}을 찾지 못했다`);
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
}

/** §2 '신호 연결'의 자원 속성 다섯 */
export function resourceAttrsFromDoc(obsText) {
  const row = obsLine(obsText, '| 신호 연결(ADR-0076) |', '§2 신호 연결');
  const m = /같은 자원 속성\(([^)]*)\)/.exec(row);
  if (!m) throw new ReadError(`${OBS} §2 신호 연결 행에서 자원 속성 목록을 찾지 못했다`);
  return [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1]);
}

// ---- 원천 ----

/** openapi에서 x-peaket-trace-rare: true를 단 작업(메서드 대문자, 경로 그대로, 경로 → 메서드 차례) */
export function rareRoutes(openapiText) {
  const doc = parseDocument(openapiText);
  if (doc.errors.length) throw new ReadError(`${OPENAPI}: YAML을 읽지 못했다: ${doc.errors[0].message.split('\n')[0]}`);
  const out = [];
  for (const [route, item] of Object.entries(doc.toJS()?.paths ?? {}))
    for (const m of HTTP_METHODS) if (item?.[m]?.['x-peaket-trace-rare'] === true) out.push({ method: m.toUpperCase(), route });
  return out.sort((a, b) => byText(a.route, b.route) || byText(a.method, b.method));
}

function readPiiSource(root) {
  let src;
  try {
    src = JSON.parse(readText(root, PII_SOURCE));
  } catch (err) {
    if (err instanceof ReadError) throw err;
    throw new ReadError(`${PII_SOURCE}: JSON을 읽지 못했다: ${err.message}`);
  }
  const ok =
    isObj(src) &&
    typeof src.mask === 'string' &&
    Array.isArray(src.patterns) &&
    src.patterns.every((p) => isObj(p) && ['name', 'pattern', 'replacement'].every((k) => typeof p[k] === 'string' && p[k].length > 0));
  if (!ok) throw new ReadError(`${PII_SOURCE}: { mask, patterns: [{ name, pattern, replacement }] } 꼴이 아니다`);
  return src;
}

// ---- 생성 ----

/** OTTL 글 값(따옴표·역빗금을 푼다) */
const ottl = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
/** 수집기 설정은 ${…}를 환경 값으로 펼친다. 글자 $는 $$로 적는다 */
const conf = (s) => s.replace(/\$/g, '$$$$');

export function tailSamplingConfig(rare, sizing) {
  const attr = (name, key, values) => ({ name, type: 'string_attribute', string_attribute: { key, values } });
  const bool = (name, key) => ({ name, type: 'boolean_attribute', boolean_attribute: { key, value: true } });
  const policies = [
    attr('head', 'peaket.sample.mode', ['head']),
    { name: 'errors', type: 'status_code', status_code: { status_codes: ['ERROR'] } },
    bool('slo-exceeded', 'peaket.slo.exceeded'),
    ...rare.map((r) => ({
      name: `rare/${r.method} ${r.route}`,
      type: 'and',
      and: {
        and_sub_policy: [
          attr('route', 'http.route', [r.route]),
          attr('method', METHOD_ATTR, [r.method]),
          { name: 'rate', type: 'rate_limiting', rate_limiting: { spans_per_second: sizing.rareSpansPerSecond } },
        ],
      },
    })),
    bool('normal-keep', 'peaket.sample.keep'),
  ];
  return {
    processors: {
      [TAIL]: {
        decision_wait: `${sizing.decisionWaitSeconds}s`,
        num_traces: sizing.numTraces,
        expected_new_traces_per_sec: sizing.expectedNewTracesPerSec,
        decision_cache: { sampled_cache_size: sizing.sampledCacheSize },
        policies,
      },
    },
  };
}

export function piiMaskingConfig(source) {
  const patterns = (target) =>
    source.patterns.flatMap((p) => Array.from({ length: PII_PASSES }, () => conf(`replace_all_patterns(${target}, "value", ${ottl(p.pattern)}, ${ottl(p.replacement)})`)));
  const body = source.patterns.flatMap((p) =>
    Array.from({ length: PII_PASSES }, () => conf(`replace_pattern(log.body, ${ottl(p.pattern)}, ${ottl(p.replacement)}) where IsString(log.body)`)),
  );
  const ips = (target) =>
    IP_ATTRS.flatMap((k) => {
      const v = `${target}[${ottl(k)}]`;
      return [
        conf(`set(${v}, ${ottl(source.mask)}) where ${v} != nil and not IsMatch(${v}, ${ottl(IP_KEEP_OR_V4)})`),
        conf(`replace_pattern(${v}, ${ottl(IP_V4)}, ${ottl('$1.0/24')})`),
      ];
    });
  return {
    processors: {
      [PII]: {
        error_mode: 'ignore',
        trace_statements: [{ statements: patterns('resource.attributes') }, { statements: [...ips('span.attributes'), ...patterns('span.attributes')] }],
        log_statements: [{ statements: patterns('resource.attributes') }, { statements: [...ips('log.attributes'), ...patterns('log.attributes'), ...body] }],
      },
    },
  };
}

const digest = (body) => createHash('sha256').update(body).digest('hex');

function render(sources, obj) {
  const body = stringify(obj, { lineWidth: 0 });
  return [
    `# 생성 파일이다. 손으로 고치지 않는다: 원천(${sources})을 고치고 \`node tools/ci/collector-config.mjs --write\``,
    '# 겹쳐 읽는 차례와 규칙은 docs/observability.md §1 \'설정 원천과 로컬 확인\', 폴더 README.md',
    `# 본문 sha256: ${digest(body)}`,
    body,
  ].join('\n');
}

/** 저장소 기준 상대 경로 → 만들 내용(generated/ 두 파일) */
export function generatedFiles(root) {
  const obs = readText(root, OBS);
  const rare = rareRoutes(readText(root, OPENAPI));
  const source = readPiiSource(root);
  return new Map([
    [FILES.tail, render(`${OPENAPI}의 x-peaket-trace-rare, ${OBS} §1 꼬리 표본 줄`, tailSamplingConfig(rare, sizingFromDoc(obs)))],
    [FILES.pii, render(`${PII_SOURCE}, ${OBS} §7 '2차 마스킹 정규식 원천'`, piiMaskingConfig(source))],
  ]);
}

/** 생성기 출력 그대로인가(머리의 본문 해시가 본문과 맞는다). 손으로 고치거나 다시 쓴 파일은 거짓 */
function pristine(text) {
  const m = HASH_LINE.exec(text);
  if (!m) return false;
  return digest(text.slice(m.index + m[0].length)) === m[1];
}

// ---- 검사 ----

/** 위반 목록(빈 배열이면 통과). 각 항목은 '<파일>: <까닭>'. 읽기 실패는 ReadError로 던진다 */
export function checkCollectorConfig(root) {
  const expected = generatedFiles(root);
  const obs = readText(root, OBS);
  const sizing = sizingFromDoc(obs);
  const resourceAttrs = resourceAttrsFromDoc(obs);
  const rare = rareRoutes(readText(root, OPENAPI));
  const source = readPiiSource(root);
  const hand = {};
  for (const k of ['agent', 'gateway', 'cluster']) hand[FILES[k]] = parseYaml(readText(root, FILES[k]), FILES[k]);

  const out = [];
  /** 생성기 출력 그대로인 생성 파일(내용 위반은 '다시 만들라' 한 줄로 모은다). 없거나 읽지 못한 생성 파일도 그 한 줄뿐이다 */
  const trusted = new Set();
  const loaded = {};
  for (const [rel, want] of expected) {
    const file = join(root, rel);
    if (!existsSync(file)) {
      out.push(`${rel}: 생성 파일이 없다. node tools/ci/collector-config.mjs --write로 만든다`);
      trusted.add(rel);
      loaded[rel] = {};
      continue;
    }
    const disk = lf(readFileSync(file, 'utf8'));
    if (disk !== want) out.push(`${rel}: 생성 결과와 다르다(손으로 고쳤거나 원천이 바뀌었다). node tools/ci/collector-config.mjs --write로 다시 만든다`);
    try {
      loaded[rel] = parseYaml(disk, rel);
      if (pristine(disk)) trusted.add(rel);
    } catch {
      loaded[rel] = {};
      trusted.add(rel);
    }
  }
  const bad = (rel, why) => {
    if (!trusted.has(rel)) out.push(`${rel}: ${why}`);
  };
  const layers = GATEWAY_ORDER.map((rel) => [rel, hand[rel] ?? loaded[rel]]);
  const gateway = layers.map(([, c]) => c).reduce(deepMerge, {});
  /** 게이트웨이에서 그 값을 마지막으로 정한 파일(아무 데도 없으면 그 값이 있어야 할 파일) */
  const definedIn = (path, fallback = FILES.gateway) => {
    const hit = layers.filter(([, c]) => getIn(c, path) !== undefined).map(([rel]) => rel);
    return hit.length ? hit[hit.length - 1] : fallback;
  };

  // --- 셋 모두: 자체 지표 :8888, 디버그 기능 없음 ---
  const common = (cfg, fileOf) => {
    const readers = cfg?.service?.telemetry?.metrics?.readers;
    const ok = Array.isArray(readers) && readers.some((r) => Number(r?.pull?.exporter?.prometheus?.port) === 8888 && r.pull.exporter.prometheus.host === '0.0.0.0');
    if (!ok) bad(fileOf(['service', 'telemetry', 'metrics']), '자체 지표는 service.telemetry.metrics의 Prometheus 당겨 가기(0.0.0.0:8888)로 낸다(§5 수집기 자체 신호)');
    const names = new Set([
      ...Object.keys(cfg?.exporters ?? {}),
      ...Object.keys(cfg?.extensions ?? {}),
      ...(cfg?.service?.extensions ?? []),
      ...Object.values(cfg?.service?.pipelines ?? {}).flatMap((p) => p?.exporters ?? []),
    ]);
    for (const n of [...names].sort(byText))
      if (DEBUG_TYPES.includes(typeOf(n))) {
        const where = getIn(cfg, ['exporters', n]) !== undefined ? ['exporters', n] : getIn(cfg, ['extensions', n]) !== undefined ? ['extensions', n] : ['service'];
        bad(fileOf(where), `운영 판에 디버그 기능 ${n}을 두지 않는다(§1)`);
      }
  };

  // --- 에이전트 ---
  const A = FILES.agent;
  const agent = hand[A];
  const agentFile = () => A;
  const agentTraces = pipelinesOf(agent, 'traces');
  const agentLogs = pipelinesOf(agent, 'logs');
  if (!agentTraces.length || !agentLogs.length) bad(A, '추적·로그 파이프라인이 있어야 한다');
  for (const p of [...agentTraces, ...agentLogs]) {
    const first = agent.service.pipelines[p]?.processors?.[0];
    if (!first || !isType(first, 'memory_limiter')) bad(A, `파이프라인 ${p}의 처리기 첫째가 메모리 상한(memory_limiter)이 아니다(${first ?? '없음'})`);
  }
  for (const p of agentTraces) {
    const ex = agent.service.pipelines[p]?.exporters ?? [];
    if (ex.length !== 1 || !isType(ex[0], 'load_balancing')) {
      bad(A, `파이프라인 ${p}의 추적 내보내기는 trace ID 부하 분산(load_balancing) 하나뿐이어야 한다(${JSON.stringify(ex)})`);
      continue;
    }
    const lb = agent.exporters?.[ex[0]];
    if (lb?.routing_key !== 'traceID') bad(A, `부하 분산 ${ex[0]}의 routing_key가 traceID가 아니다(${lb?.routing_key ?? '없음'})`);
    if (!isObj(lb?.resolver?.k8s) || Object.keys(lb.resolver).length !== 1) bad(A, `부하 분산 ${ex[0]}은 운영 판에서 쿠버네티스 해석기(resolver.k8s) 하나로 게이트웨이 복제를 찾는다`);
  }
  const k8s = named(agent.processors, 'k8s_attributes');
  const usedK8s = (p) => (agent.service.pipelines[p]?.processors ?? []).some((x) => isType(x, 'k8s_attributes'));
  if (!k8s.length || ![...agentTraces, ...agentLogs].every(usedK8s)) bad(A, '추적·로그 파이프라인 모두에 쿠버네티스 메타데이터 처리기(k8s_attributes)가 있어야 한다');
  const given = new Set(
    k8s.flatMap((k) => {
      const ex = agent.processors[k]?.extract ?? {};
      return [...(ex.metadata ?? []), ...[...(ex.labels ?? []), ...(ex.annotations ?? [])].map((x) => x?.tag_name)];
    }),
  );
  for (const a of resourceAttrs) if (!given.has(a)) bad(A, `쿠버네티스 메타데이터 처리기가 자원 속성 ${a}를 붙이지 않는다(§2 신호 연결)`);
  common(agent, agentFile);

  // --- 게이트웨이(운영 판을 겹쳐 읽은 결과) ---
  for (const k of named(gateway.processors, 'memory_limiter'))
    for (const [key, want] of [
      ['limit_percentage', sizing.limitPercentage],
      ['spike_limit_percentage', sizing.spikeLimitPercentage],
    ])
      if (gateway.processors[k]?.[key] !== want) bad(definedIn(['processors', k, key]), `메모리 상한 ${k}의 ${key}가 §1의 값 ${want}이 아니다(${gateway.processors[k]?.[key] ?? '없음'})`);
  const ts = gateway.processors?.[TAIL];
  if (!isObj(ts)) bad(definedIn(['processors', TAIL], FILES.tail), `꼬리 표본 처리기 ${TAIL}가 없다`);
  else {
    for (const [path, want, got] of [
      [['decision_wait'], `${sizing.decisionWaitSeconds}s`, String(ts.decision_wait)],
      [['num_traces'], sizing.numTraces, Number(ts.num_traces)],
      [['expected_new_traces_per_sec'], sizing.expectedNewTracesPerSec, Number(ts.expected_new_traces_per_sec)],
      [['decision_cache', 'sampled_cache_size'], sizing.sampledCacheSize, Number(ts.decision_cache?.sampled_cache_size)],
    ])
      if (got !== want) bad(definedIn(['processors', TAIL, ...path], FILES.tail), `꼬리 표본 ${path.join('.')}가 §1·§6의 값 ${want}이 아니다(${got})`);
    const pf = definedIn(['processors', TAIL, 'policies'], FILES.tail);
    const policies = Array.isArray(ts.policies) ? ts.policies : [];
    const byName = new Map(policies.map((p) => [p?.name, p]));
    const required = [
      ['head', (p) => p.type === 'string_attribute' && p.string_attribute?.key === 'peaket.sample.mode' && JSON.stringify(p.string_attribute?.values) === '["head"]'],
      ['errors', (p) => p.type === 'status_code' && JSON.stringify(p.status_code?.status_codes) === '["ERROR"]'],
      ['slo-exceeded', (p) => p.type === 'boolean_attribute' && p.boolean_attribute?.key === 'peaket.slo.exceeded' && p.boolean_attribute?.value === true],
      ['normal-keep', (p) => p.type === 'boolean_attribute' && p.boolean_attribute?.key === 'peaket.sample.keep' && p.boolean_attribute?.value === true],
    ];
    for (const [name, okDef] of required) {
      const p = byName.get(name);
      if (!p) bad(pf, `꼬리 표본 정책 ${name}이 없다(§1 정책 다섯)`);
      else if (!okDef(p)) bad(pf, `꼬리 표본 정책 ${name}의 정의가 §1과 다르다(${JSON.stringify(p)})`);
    }
    const wantRare = new Map(rare.map((r) => [`rare/${r.method} ${r.route}`, r]));
    for (const p of policies) {
      const name = String(p?.name ?? '');
      if (p?.type === 'probabilistic') bad(pf, `확률 표본 정책(probabilistic) ${name}을 두지 않는다(§1)`);
      else if (!required.some(([n]) => n === name) && !name.startsWith('rare/')) bad(pf, `꼬리 표본 정책 ${name}(${p?.type})은 §1의 다섯 밖이다`);
    }
    const haveRare = policies.filter((p) => String(p?.name ?? '').startsWith('rare/') && p?.type !== 'probabilistic');
    for (const name of wantRare.keys()) if (!byName.has(name)) bad(pf, `드문 경로 정책 ${name}이 없다(openapi x-peaket-trace-rare)`);
    for (const p of haveRare) {
      const r = wantRare.get(p.name);
      if (!r) {
        bad(pf, `드문 경로 정책 ${p.name}은 openapi에 x-peaket-trace-rare 표시가 없다`);
        continue;
      }
      const subs = p.and?.and_sub_policy ?? [];
      const has = (type, ok) => subs.some((s) => s?.type === type && ok(s));
      const ok =
        p.type === 'and' &&
        subs.length === 3 &&
        has('string_attribute', (s) => s.string_attribute?.key === 'http.route' && JSON.stringify(s.string_attribute?.values) === JSON.stringify([r.route])) &&
        has('string_attribute', (s) => s.string_attribute?.key === METHOD_ATTR && JSON.stringify(s.string_attribute?.values) === JSON.stringify([r.method])) &&
        has('rate_limiting', (s) => s.rate_limiting?.spans_per_second === sizing.rareSpansPerSecond);
      if (!ok) bad(pf, `드문 경로 정책 ${p.name}은 and(http.route 같음 + ${METHOD_ATTR} 같음 + rate_limiting 초당 ${sizing.rareSpansPerSecond} span)여야 한다`);
    }
    const rank = (n) => (n === 'head' ? 0 : n === 'errors' ? 1 : n === 'slo-exceeded' ? 2 : n.startsWith('rare/') ? 3 : n === 'normal-keep' ? 4 : -1);
    const ranks = policies.map((p) => rank(String(p?.name ?? ''))).filter((x) => x >= 0);
    if (ranks.some((x, i) => i > 0 && x < ranks[i - 1])) bad(pf, '꼬리 표본 정책 차례는 head → errors → slo-exceeded → 드문 경로 → normal-keep이다(§1)');
  }
  for (const [signal, middle] of [
    ['traces', [TAIL, PII]],
    ['logs', [PII]],
  ]) {
    const ps = pipelinesOf(gateway, signal);
    if (!ps.length) bad(definedIn(['service', 'pipelines']), `${signal} 파이프라인이 없다`);
    for (const p of ps) {
      const pr = gateway.service.pipelines[p]?.processors ?? [];
      const f = definedIn(['service', 'pipelines', p, 'processors']);
      let shape = true;
      if (!pr[0] || !isType(pr[0], 'memory_limiter')) {
        bad(f, `파이프라인 ${p}의 처리기 첫째가 메모리 상한(memory_limiter)이 아니다`);
        shape = false;
      }
      for (const m of middle)
        if (!pr.includes(m)) {
          bad(f, `파이프라인 ${p}에 ${m === PII ? '2차 마스킹' : '꼬리 표본'} 처리기 ${m}이 없다`);
          shape = false;
        }
      if (shape && (JSON.stringify(pr.slice(1, 1 + middle.length)) !== JSON.stringify(middle) || !isType(pr[pr.length - 1], 'batch')))
        bad(f, `파이프라인 ${p}의 처리기 차례는 memory_limiter → ${middle.join(' → ')} → … → batch다(${pr.join(', ')})`);
    }
  }
  // --- 게이트웨이: Loki 라벨 넷(§1 Loki 줄, §7 라벨 허용 목록). 로그 파이프라인에서만 2차 마스킹 뒤·묶기 앞에 둔다 ---
  const labelsFile = definedIn(['processors', LOKI_LABELS]);
  const labelsProc = gateway.processors?.[LOKI_LABELS];
  if (!isObj(labelsProc)) bad(labelsFile, `Loki 라벨 처리기 ${LOKI_LABELS}가 없다(namespace·service·env·cluster를 자원 속성에서 복사한다)`);
  else {
    const statements = (Array.isArray(labelsProc.log_statements) ? labelsProc.log_statements : [])
      .flatMap((g) => (Array.isArray(g?.statements) ? g.statements : []))
      .map(String);
    const cluster = new RegExp(`set\\(resource\\.attributes\\["cluster"\\],\\s*"\\$\\{env:${CLUSTER_ENV}\\}"\\)`);
    for (const [label, source] of [...Object.entries(LOKI_LABEL_SOURCES), ['cluster', undefined]]) {
      const ok = statements.some((s) => (source === undefined ? cluster.test(s) : s.includes(`set(resource.attributes["${label}"], resource.attributes["${source}"])`)));
      if (!ok) bad(labelsFile, `Loki 라벨 ${label}을 ${source ?? `환경 변수 ${CLUSTER_ENV}`}에서 복사하는 문장이 없다(§1·§7)`);
    }
    for (const s of statements) {
      const name = /resource\.attributes\["([a-z]+)"\]/.exec(s)?.[1];
      if (name !== undefined && name !== 'cluster' && !(name in LOKI_LABEL_SOURCES)) bad(labelsFile, `Loki 라벨 처리기가 허용 목록 밖 자원 속성 ${name}을(를) 만든다(§7)`);
    }
    for (const p of pipelinesOf(gateway, 'traces')) {
      if ((gateway.service.pipelines[p]?.processors ?? []).includes(LOKI_LABELS)) bad(definedIn(['service', 'pipelines', p, 'processors']), `추적 파이프라인 ${p}에 Loki 라벨 처리기를 두지 않는다(로그만 색인한다)`);
    }
    for (const p of pipelinesOf(gateway, 'logs')) {
      const pr = gateway.service.pipelines[p]?.processors ?? [];
      const li = pr.indexOf(LOKI_LABELS);
      const pi = pr.indexOf(PII);
      const f = definedIn(['service', 'pipelines', p, 'processors']);
      if (li < 0) bad(f, `로그 파이프라인 ${p}에 Loki 라벨 처리기 ${LOKI_LABELS}가 없다`);
      else if (pi >= 0 && (li < pi || li > pr.length - 2)) bad(f, `로그 파이프라인 ${p}의 Loki 라벨 처리기 차례가 2차 마스킹 뒤·묶기 앞이 아니다(${pr.join(', ')})`);
      // 2차 마스킹 처리기가 없으면 위의 파이프라인 검사가 이미 막았다(막음 줄을 겹쳐 내지 않는다)
    }
  }
  common(gateway, (path) => definedIn(path));

  // --- 클러스터 ---
  const C = FILES.cluster;
  const cluster = hand[C];
  const objs = named(cluster.receivers, 'k8s_objects');
  if (!objs.length) bad(C, '쿠버네티스 이벤트 수신기(k8s_objects)가 없다');
  for (const r of objs) {
    const e = cluster.receivers[r]?.k8s_leader_elector;
    const ok = typeof e === 'string' && isType(e, 'k8s_leader_elector') && cluster.extensions?.[e] !== undefined && (cluster.service?.extensions ?? []).includes(e);
    if (!ok) bad(C, `수신기 ${r}가 리더 선출 확장(k8s_leader_elector)에 묶이지 않았다(복제 둘이 같은 이벤트를 두 번 받는다)`);
  }
  common(cluster, () => C);

  // --- 원천: 두 엔진(RE2·자바스크립트)이 함께 읽는 문법 ---
  for (const p of source.patterns)
    if (/\(\?[=!<>]|\\[1-9]|\\k</.test(p.pattern)) out.push(`${PII_SOURCE}: 꼴 ${p.name}에 RE2가 받지 않는 문법(앞뒤 살피기·뒤 참조)이 있다(§7)`);

  return out;
}

function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { check: { type: 'boolean' }, write: { type: 'boolean' }, root: { type: 'string' } }, strict: true, allowPositionals: false }));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    return 2;
  }
  if (Boolean(values.check) === Boolean(values.write) || values.root === '') {
    console.error(USAGE);
    return 2;
  }
  const root = resolve(values.root ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
  try {
    if (values.write) {
      for (const [rel, text] of generatedFiles(root)) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), text);
        console.log(`collector-config: 씀 ${rel}`);
      }
      return 0;
    }
    const problems = checkCollectorConfig(root);
    if (problems.length) {
      for (const p of problems) console.log(`막음: ${p}`);
      return 1;
    }
    console.log('collector-config: 수집기 설정이 §1의 규칙과 생성 원천에 맞다');
    return 0;
  } catch (err) {
    if (err instanceof ReadError) {
      console.error(`collector-config: ${err.message}`);
      return 2;
    }
    throw err;
  }
}

await runIfMain(import.meta.url, () => main(process.argv.slice(2)));
