#!/usr/bin/env node
// 경보 규칙 검사(기능 F-01-7 A1, OPS-130, 시험 V-T16·V-T20 ①②③·V-T54 ①②, 계획 docs/review/plans/F-01-7.md §3·§5).
// 정본: docs/observability.md §4 '긁기·평가·알림 간격'(간격 규칙 셋과 '검사 방법'), §5 '경보 묶기와 억제'의 '경보 규칙 검사',
// §8 허용 라벨·히스토그램 버킷 구성, docs/verification.md §2.7. 값(칸 목록·허용 라벨·kind 목록·severity 목록)은 정본 글에서 읽고 여기 옮겨 적지 않는다.
// 읽는 것:
// - 규칙 파일: deploy/platform/observability/의 rules/·alerts/(PrometheusRule의 spec.groups)와 mimir/rules/(최상위 groups)
// - 규칙 시험 파일 test/*.test.yaml, slo-fast 긁기 작업 prometheus/scrape-slo-fast.yaml, 설정 alert-check.yaml(그 밖의 긁기 간격·시험 간격 예외)
// - Alertmanager 설정 alertmanager/alertmanager.yaml(이름 경로·묶음 값·억제), deploy/gateways/의 YAML(Envoy histogram_bucket_settings, 있으면)
// - packages/platform/src/metrics.ts(서비스 템플릿 칸 목록)·pii-patterns.json(2차 마스킹 꼴),
//   services/admission-ctrl/src/modules/leader/domain/plan.ts(INPUT_STALE_MS)·adapters/prometheus-control-inputs.ts(CONTROL_QUERIES)
// 쓰는 법: node tools/ci/alert-check.mjs [--root <저장소>]
// 끝 코드: 0 통과, 1 위반(하나도 빠짐없이 '막음: <저장소 기준 경로>: <경보·묶음·시험 묶음 이름>: <까닭>'),
//   2 인자 오류·읽을 파일 없음·규칙 파일 0개·정본 목록이나 상수를 읽지 못함(읽지 못한 것을 통과로도 위반으로도 내지 않는다).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';

const USAGE = '쓰는 법: node tools/ci/alert-check.mjs [--root <저장소>]';
const OBS = 'deploy/platform/observability';
/** 규칙 파일이 있는 곳과 그 꼴(tools/ci/prom-rules.mjs의 RULE_DIRS와 같은 자리) */
const RULE_DIRS = [
  [`${OBS}/rules`, 'crd'],
  [`${OBS}/alerts`, 'crd'],
  [`${OBS}/mimir/rules`, 'plain'],
];
const TEST_DIR = `${OBS}/test`;
const SLO_FAST = `${OBS}/prometheus/scrape-slo-fast.yaml`;
const CONFIG = `${OBS}/alert-check.yaml`;
const ALERTMANAGER = `${OBS}/alertmanager/alertmanager.yaml`;
const GATEWAYS = 'deploy/gateways';
const DOC = 'docs/observability.md';
const METRICS = 'packages/platform/src/metrics.ts';
const PII = 'packages/platform/src/pii-patterns.json';
const PLAN_TS = 'services/admission-ctrl/src/modules/leader/domain/plan.ts';
const CONTROL_TS = 'services/admission-ctrl/src/modules/leader/adapters/prometheus-control-inputs.ts';

/** 간격 규칙 ①(창 ≥ 긁기 간격 × 4)과 ②(입력 없음 ≥ 긁기 간격 × 3)의 배수(docs/observability.md §4 '긁기·평가·알림 간격') */
const WINDOW_FACTOR = 4;
const STALE_FACTOR = 3;
/** 묶음에 interval이 없을 때 Prometheus가 쓰는 전역 기본 평가 간격, promtool 시험 파일의 evaluation_interval 기본값(§4 첫 문단) */
const PROMETHEUS_DEFAULT_INTERVAL = '1m';
/** Alertmanager 경로 기본값(§4 간격 표 'SEV3 경로'의 기본값, Alertmanager 설정 문서) */
const AM_DEFAULTS = { group_wait: '30s', group_interval: '5m', repeat_interval: '4h' };
/** SEV1·SEV2 경로의 묶음 값(§4 간격 표 'Alertmanager SEV1·SEV2 경로') */
const AM_FAST = { group_wait: '5s', group_interval: '1m' };

/** 끝 코드 2로 끝낼 오류 */
class UsageError extends Error {}

const toPosix = (p) => p.split('\\').join('/');

export function parseArgs(argv) {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError('--root에 값이 없다');
      root = resolve(v);
      i++;
    } else if (a.startsWith('--root=') && a.length > '--root='.length) root = resolve(a.slice('--root='.length));
    else throw new UsageError(`모르는 인자 ${a}`);
  }
  return { root };
}

// ---------------------------------------------------------------------------
// 읽기
// ---------------------------------------------------------------------------

function readText(root, rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) throw new UsageError(`${rel}이 없다`);
  return readFileSync(abs, 'utf8');
}

function readYamlDocs(root, rel) {
  const docs = parseAllDocuments(readText(root, rel));
  for (const d of docs) if (d.errors.length) throw new UsageError(`${rel}: YAML을 읽지 못했다: ${d.errors[0].message.split('\n')[0]}`);
  return docs.map((d) => d.toJS()).filter((x) => x !== null && x !== undefined);
}

function readYaml(root, rel) {
  const docs = readYamlDocs(root, rel);
  if (docs.length !== 1) throw new UsageError(`${rel}: YAML 문서가 하나가 아니다(${docs.length})`);
  return docs[0];
}

const yamlFiles = (abs) => (existsSync(abs) ? readdirSync(abs).filter((f) => /\.ya?ml$/.test(f)).sort() : []);

/** 규칙 파일 하나의 묶음 목록 */
function ruleGroups(root, rel, kind) {
  const values = readYamlDocs(root, rel);
  if (kind === 'crd') {
    const crds = values.filter((v) => v?.kind === 'PrometheusRule');
    if (!crds.length || crds.some((c) => !Array.isArray(c.spec?.groups))) throw new UsageError(`${rel}: spec.groups 목록을 가진 PrometheusRule이 없다`);
    return crds.flatMap((c) => c.spec.groups);
  }
  if (values.length !== 1 || !Array.isArray(values[0]?.groups)) throw new UsageError(`${rel}: 최상위 groups 목록 하나인 규칙 파일이 아니다`);
  return values[0].groups;
}

/** Prometheus 기간 글(5s, 1m30s, 28d …)을 밀리초로. 읽지 못하면 null */
export function durationMs(text) {
  if (typeof text !== 'string' || !/^(\d+(ms|s|m|h|d|w|y))+$/.test(text.trim())) return null;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000, y: 31_536_000_000 };
  let total = 0;
  for (const m of text.trim().matchAll(/(\d+)(ms|s|m|h|d|w|y)/g)) total += Number(m[1]) * unit[m[2]];
  return total;
}

const showMs = (ms) => {
  for (const [u, n] of [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000]]) if (ms % n === 0 && ms >= n) return `${ms / n}${u}`;
  return `${ms}ms`;
};

/** 정본 글에서 읽는 목록(칸·허용 라벨·kind·severity). 하나라도 못 읽으면 2 */
function readCanon(root) {
  const doc = readText(root, DOC);
  const buckets = /목록\(초\)은 ([^(]*?)\(\+Inf\)이다/.exec(doc);
  if (!buckets) throw new UsageError(`${DOC}: §8 '히스토그램 버킷 구성'의 표준 칸 목록 글('목록(초)은 … (+Inf)이다')을 찾지 못했다`);
  const standard = buckets[1].split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  if (!standard.length || standard.some((n) => !Number.isFinite(n))) throw new UsageError(`${DOC}: 표준 칸 목록을 숫자로 읽지 못했다: ${buckets[1]}`);

  const ticks = (s) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const allowedLine = doc.split('\n').find((l) => l.startsWith('- 허용 라벨(Label):'));
  if (!allowedLine) throw new UsageError(`${DOC}: §8 '허용 라벨(Label)' 줄을 찾지 못했다`);
  const allowed = ticks(allowedLine).filter((n) => /^[a-z_]+$/.test(n));
  const extraLine = /- 이용자 식별값: .*?은 §8 허용 라벨, (.*?)만 쓴다/.exec(doc);
  if (!allowed.length || !extraLine) throw new UsageError(`${DOC}: §5 '경보 규칙 검사'의 이용자 식별값 허용 목록 글을 찾지 못했다`);
  const extra = ticks(extraLine[1]).filter((n) => /^[a-z_]+$/.test(n));

  const kinds = /`kind`\(([a-z·]+)\) 레이블을 붙이고/.exec(doc);
  if (!kinds) throw new UsageError(`${DOC}: §5 '경보 묶기와 억제'의 kind 목록 글을 찾지 못했다`);
  const severities = /라벨 값: `severity`는 (sev\d(?:·sev\d)*)/.exec(doc);
  if (!severities) throw new UsageError(`${DOC}: §5 '경보 규칙 검사'의 severity 목록 글을 찾지 못했다`);
  return {
    standard,
    allowedLabels: new Set([...allowed, ...extra]),
    kinds: new Set(kinds[1].split('·')),
    severities: new Set(severities[1].split('·')),
  };
}

function readSloFastInterval(root) {
  const pm = readYaml(root, SLO_FAST);
  const intervals = [...new Set((pm?.spec?.podMetricsEndpoints ?? []).map((e) => e?.interval))];
  if (intervals.length !== 1 || durationMs(intervals[0]) === null) throw new UsageError(`${SLO_FAST}: podMetricsEndpoints의 interval을 하나로 읽지 못했다(${intervals.join(', ') || '없음'})`);
  return durationMs(intervals[0]);
}

function readConfig(root) {
  const cfg = readYaml(root, CONFIG);
  const other = durationMs(cfg?.otherScrapeInterval);
  if (other === null) throw new UsageError(`${CONFIG}: otherScrapeInterval을 기간으로 읽지 못했다`);
  const ex = cfg.testIntervalExceptions ?? [];
  if (!Array.isArray(ex)) throw new UsageError(`${CONFIG}: testIntervalExceptions가 목록이 아니다`);
  return { otherScrapeMs: other, exceptions: ex };
}

/** 배열 글 안의 숫자(밑줄 허용) */
const numbersIn = (s) => s.split(',').map((x) => x.trim()).filter(Boolean).map((x) => Number(x.replace(/_/g, '')));

function readTemplateBuckets(root) {
  const text = readText(root, METRICS);
  const m = /LATENCY_BUCKETS_SECONDS\b[^=]*=\s*Object\.freeze\(\[([^\]]*)\]/.exec(text);
  if (!m) throw new UsageError(`${METRICS}: LATENCY_BUCKETS_SECONDS의 Object.freeze([ … ]) 목록을 찾지 못했다`);
  const list = numbersIn(m[1]);
  if (list.some((n) => !Number.isFinite(n))) throw new UsageError(`${METRICS}: LATENCY_BUCKETS_SECONDS를 숫자로 읽지 못했다`);
  return list;
}

function readPii(root) {
  let json;
  try {
    json = JSON.parse(readText(root, PII));
  } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError(`${PII}: JSON을 읽지 못했다`);
  }
  if (!Array.isArray(json?.patterns) || !json.patterns.length) throw new UsageError(`${PII}: patterns가 없다`);
  return json.patterns.map((p) => ({ name: p.name, re: new RegExp(p.pattern) }));
}

function readStaleMs(root) {
  const m = /export const INPUT_STALE_MS\s*=\s*([\d_]+)\s*;/.exec(readText(root, PLAN_TS));
  if (!m) throw new UsageError(`${PLAN_TS}: 'export const INPUT_STALE_MS = <숫자>;' 줄을 찾지 못했다`);
  return Number(m[1].replace(/_/g, ''));
}

/** CONTROL_QUERIES 블록 안의 글자에서 자동 제어가 읽는 이름. 글자가 아닌 칸(다른 파일 상수)의 수도 센다 */
function readControlNames(root) {
  const text = readText(root, CONTROL_TS);
  const start = /export const CONTROL_QUERIES\s*=\s*\{/.exec(text);
  if (!start) throw new UsageError(`${CONTROL_TS}: 'export const CONTROL_QUERIES = {' 선언을 찾지 못했다`);
  let depth = 0;
  let end = -1;
  for (let i = start.index + start[0].length - 1; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new UsageError(`${CONTROL_TS}: CONTROL_QUERIES 블록의 끝을 찾지 못했다`);
  const block = text.slice(start.index + start[0].length, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const names = new Set();
  for (const m of block.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)) for (const n of metricNames((m[1] ?? m[2] ?? m[3]).replace(/\$\{[^}]*\}/g, ' '))) names.add(n);
  // 글자가 아닌 값(예: pgLimitRatio: PG_RATIO_QUERY)은 다른 파일의 상수라 이름을 읽지 못한다. 원천 지표로 본다(계획 §3 '간격 ②')
  const opaque = [...block.matchAll(/^\s*\w+\s*:\s*([A-Z][A-Z0-9_]*)\s*,?\s*$/gm)].map((m) => m[1]);
  if (!names.size) throw new UsageError(`${CONTROL_TS}: CONTROL_QUERIES에서 자동 제어가 읽는 이름을 하나도 찾지 못했다`);
  return { names: [...names], opaque };
}

// ---------------------------------------------------------------------------
// PromQL 읽기(정적, 검사에 필요한 만큼만)
// ---------------------------------------------------------------------------

const KEYWORDS = new Set(['and', 'or', 'unless', 'bool', 'offset', 'by', 'without', 'on', 'ignoring', 'group_left', 'group_right', 'inf', 'nan', 'start', 'end']);

/** 글자 값("…"·'…'·`…`)을 빈 글자로 바꾼다(라벨 값 안의 괄호·대괄호를 식으로 읽지 않게) */
const stripStrings = (expr) => expr.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, '""');

/** 식 조각에서 지표·기록 규칙 이름(함수·키워드·라벨 이름 빼고) */
export function metricNames(fragment) {
  const s = stripStrings(fragment)
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, ' ');
  const out = [];
  for (const m of s.matchAll(/(?<![\w.:])([a-zA-Z_:][\w:]*)(?!\s*\()/g)) if (!KEYWORDS.has(m[1].toLowerCase())) out.push(m[1]);
  return out;
}

/** 범위 조회마다 { names, window, step } (부분 조회 [창:해상도]는 step이 있다) */
export function rangeQueries(expr) {
  const s = stripStrings(expr);
  const out = [];
  for (const m of s.matchAll(/\[\s*([0-9a-z]+)\s*(?::\s*([0-9a-z]*)\s*)?\]/g)) {
    let i = m.index - 1;
    while (i >= 0 && /\s/.test(s[i])) i--;
    let names = [];
    const nameBefore = (j) => {
      while (j >= 0 && /\s/.test(s[j])) j--;
      const nm = /[a-zA-Z_:][\w:]*$/.exec(s.slice(0, j + 1));
      return nm ? [nm[0]] : [];
    };
    if (s[i] === '}') names = nameBefore(s.lastIndexOf('{', i) - 1);
    else if (s[i] === ')') {
      let depth = 0;
      let j = i;
      for (; j >= 0; j--) {
        if (s[j] === ')') depth++;
        else if (s[j] === '(' && --depth === 0) break;
      }
      names = metricNames(s.slice(j + 1, i));
    } else names = nameBefore(i);
    out.push({ names, window: m[1], step: m[2] || undefined, text: m[0] });
  }
  return out;
}

/** 히스토그램 칸 조회마다 { metric, unit, le } (_seconds_bucket·_ms_bucket의 le="x"만) */
function bucketMatchers(expr) {
  const out = [];
  for (const m of expr.matchAll(/([a-zA-Z_:][\w:]*)_(seconds|ms)_bucket\s*\{([^}]*)\}/g)) {
    for (const le of m[3].matchAll(/(?:^|,)\s*le\s*=\s*"([^"]*)"/g)) out.push({ metric: `${m[1]}_${m[2]}_bucket`, unit: m[2], le: le[1] });
  }
  return out;
}

const sameNumber = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

// ---------------------------------------------------------------------------
// Alertmanager 설정
// ---------------------------------------------------------------------------

/** 경로 하나가 맞추는 { alertnames, severities } (= 맞추기만. 정규식·부정은 보지 않는다) */
function routeMatches(route) {
  const alertnames = [];
  const severities = [];
  const add = (k, v) => {
    if (k === 'alertname') alertnames.push(v);
    if (k === 'severity') severities.push(v);
  };
  for (const m of Array.isArray(route?.matchers) ? route.matchers : []) {
    if (typeof m !== 'string') continue;
    for (const part of m.replace(/^\{|\}$/g, '').split(',')) {
      const mm = /^\s*([a-zA-Z_]\w*)\s*=(?![=~])\s*"?([^"]*?)"?\s*$/.exec(part);
      if (mm) add(mm[1], mm[2]);
    }
  }
  for (const [k, v] of Object.entries(route?.match ?? {})) add(k, String(v));
  return { alertnames, severities };
}

function walkRoutes(route, visit, parentEff, inherited = null) {
  const eff = {};
  for (const k of Object.keys(AM_DEFAULTS)) eff[k] = route?.[k] ?? parentEff[k];
  const { severities } = routeMatches(route);
  const sev = severities.length ? severities[0] : inherited;
  visit(route, eff, sev, severities.length > 0);
  for (const child of Array.isArray(route?.routes) ? route.routes : []) walkRoutes(child, visit, eff, sev);
}

const normMatcher = (m) => String(m).replace(/\s+/g, '');

function checkAlertmanager(am, add) {
  const names = new Set();
  const seen = new Set();
  if (!am?.route) {
    add(`${ALERTMANAGER}: route: 맨 위 경로(route)가 없다`);
    return names;
  }
  walkRoutes(
    am.route,
    (route, eff, sev, own) => {
      for (const n of routeMatches(route).alertnames) names.add(n);
      if (!sev) return;
      if (own) seen.add(sev);
      const label = `severity="${sev}" 경로`;
      if (sev === 'sev1' || sev === 'sev2') {
        for (const [k, want] of Object.entries(AM_FAST)) {
          if (durationMs(String(eff[k])) !== durationMs(want)) add(`${ALERTMANAGER}: ${label}: ${k}가 ${eff[k]}이다(SEV1·SEV2 경로는 ${want}, docs/observability.md §4 간격 표)`);
        }
      } else if (sev === 'sev3') {
        for (const [k, def] of Object.entries(AM_DEFAULTS)) {
          if (route[k] !== undefined) add(`${ALERTMANAGER}: ${label}: ${k}를 적었다(${route[k]}). SEV3 경로는 기본값이다(docs/observability.md §4 간격 표)`);
          else if (durationMs(String(eff[k])) !== durationMs(def)) add(`${ALERTMANAGER}: ${label}: 위 경로에서 물려받은 ${k}가 ${eff[k]}이다(SEV3 경로는 기본값 ${def})`);
        }
      }
    },
    AM_DEFAULTS,
  );
  for (const sev of ['sev1', 'sev2', 'sev3']) if (!seen.has(sev)) add(`${ALERTMANAGER}: severity="${sev}" 경로: 경로가 없다`);
  // 억제(§5 '첫 구현'의 억제): 누르는 쪽 sev1·slo·event_id·journey 있음, 눌리는 쪽 sev2, equal [event_id, journey]
  const want = { source: ['severity="sev1"', 'kind="slo"', 'event_id=~".+"', 'journey=~".+"'], target: ['severity="sev2"'], equal: ['event_id', 'journey'] };
  const ok = (Array.isArray(am.inhibit_rules) ? am.inhibit_rules : []).some((r) => {
    const src = new Set((r?.source_matchers ?? []).map(normMatcher));
    const tgt = new Set((r?.target_matchers ?? []).map(normMatcher));
    const eq = [...(r?.equal ?? [])].sort();
    return want.source.every((m) => src.has(m)) && want.target.every((m) => tgt.has(m)) && eq.join(',') === [...want.equal].sort().join(',');
  });
  if (!ok) add(`${ALERTMANAGER}: inhibit_rules: 예산 SEV1이 같은 event_id·journey의 SEV2를 누르는 규칙(누르는 쪽 ${want.source.join(' ')}, 눌리는 쪽 ${want.target.join(' ')}, equal [${want.equal.join(', ')}])이 없다`);
  return names;
}

// ---------------------------------------------------------------------------
// 검사
// ---------------------------------------------------------------------------

/** 저장소를 검사한다. { violations, notes, counts }. 읽지 못하면 UsageError를 던진다 */
export function inspect(root) {
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new UsageError(`저장소 폴더가 없다: ${root}`);
  if (!existsSync(join(root, OBS))) throw new UsageError(`${OBS}가 없다: ${root}`);
  const violations = [];
  const seenLine = new Set();
  const add = (line) => {
    if (!seenLine.has(line)) {
      seenLine.add(line);
      violations.push(line);
    }
  };
  const notes = [];

  const canon = readCanon(root);
  const sloFastMs = readSloFastInterval(root);
  const { otherScrapeMs, exceptions } = readConfig(root);
  const templateBuckets = readTemplateBuckets(root);
  const pii = readPii(root);
  const staleMs = readStaleMs(root);
  const control = readControlNames(root);
  const am = readYaml(root, ALERTMANAGER);

  // 규칙 파일과 묶음
  const files = RULE_DIRS.flatMap(([dir, kind]) => yamlFiles(join(root, dir)).map((f) => ({ rel: `${dir}/${f}`, kind })));
  if (!files.length) throw new UsageError(`규칙 파일이 없다(${RULE_DIRS.map(([d]) => d).join(', ')})`);
  const groups = [];
  for (const { rel, kind } of files) {
    for (const g of ruleGroups(root, rel, kind)) {
      const name = g?.name ?? '(이름 없음)';
      const ms = durationMs(g?.interval === undefined ? undefined : String(g.interval));
      if (g?.interval === undefined) add(`${rel}: ${name}: 규칙 묶음에 평가 간격(interval)이 없다(docs/observability.md §4 '검사 방법')`);
      else if (ms === null) add(`${rel}: ${name}: 평가 간격 ${g.interval}을 기간으로 읽지 못했다`);
      groups.push({ rel, name, intervalMs: ms ?? durationMs(PROMETHEUS_DEFAULT_INTERVAL), rules: Array.isArray(g?.rules) ? g.rules : [] });
    }
  }
  /** 기록 규칙 이름 → 그 이름을 내는 묶음들의 평가 간격(가장 긴 것) */
  const recordMs = new Map();
  for (const g of groups) for (const r of g.rules) if (r?.record) recordMs.set(r.record, Math.max(recordMs.get(r.record) ?? 0, g.intervalMs));
  const groupIntervals = new Map(groups.map((g) => [`${g.rel}#${g.name}`, g.intervalMs]));
  const amNames = checkAlertmanager(am, add);

  let alerts = 0;
  const allowedLabel = (n) => canon.allowedLabels.has(n);
  for (const g of groups) {
    for (const r of g.rules) {
      const id = r?.alert ?? r?.record ?? '(이름 없음)';
      const where = `${g.rel}: ${id}`;
      const expr = typeof r?.expr === 'string' ? r.expr : String(r?.expr ?? '');

      // 간격 ①: 범위 조회의 창 ≥ 그 이름의 긁기 간격 × 4, 부분 조회 해상도 ≥ 묶음 평가 간격
      for (const q of rangeQueries(expr)) {
        const win = durationMs(q.window);
        if (win === null) continue;
        let scrape = 0;
        let by = '';
        for (const n of q.names.length ? q.names : ['(원천 지표)']) {
          const ms = recordMs.has(n) ? recordMs.get(n) : g.intervalMs === sloFastMs ? sloFastMs : otherScrapeMs;
          if (ms > scrape) [scrape, by] = [ms, n];
        }
        if (win < WINDOW_FACTOR * scrape) {
          add(`${where}: 범위 ${q.text}가 ${by}의 긁기 간격 ${showMs(scrape)}의 ${WINDOW_FACTOR}배(${showMs(WINDOW_FACTOR * scrape)})보다 짧다(docs/observability.md §4 간격 규칙 ①)`);
        }
        const step = q.step === undefined ? null : durationMs(q.step);
        if (step !== null && step < g.intervalMs) add(`${where}: 부분 조회 ${q.text}의 해상도 ${q.step}가 묶음 평가 간격 ${showMs(g.intervalMs)}보다 짧다`);
      }

      // 히스토그램 칸(V-T16): 규칙의 le 값이 표준 칸 목록에 있다
      for (const b of bucketMatchers(expr)) {
        if (b.le === '+Inf') continue;
        const v = Number(b.le);
        const sec = b.unit === 'ms' ? v / 1000 : v;
        if (!Number.isFinite(v) || !canon.standard.some((x) => sameNumber(x, sec))) {
          add(`${where}: ${b.metric}의 le="${b.le}"가 표준 칸 목록(docs/observability.md §8 '히스토그램 버킷 구성')에 없다`);
        }
      }

      // 이용자 식별값: labels 이름, by (…)·without (…) 이름, 라벨 값·주석 틀의 $labels
      for (const k of Object.keys(r?.labels ?? {})) if (!allowedLabel(k)) add(`${where}: 라벨 이름 ${k}가 허용 목록 밖이다(docs/observability.md §5 '경보 규칙 검사'의 이용자 식별값)`);
      for (const m of stripStrings(expr).matchAll(/\b(by|without)\s*\(([^)]*)\)/g)) {
        for (const n of m[2].split(',').map((x) => x.trim()).filter(Boolean)) if (!allowedLabel(n)) add(`${where}: ${m[1]} (…)의 라벨 이름 ${n}가 허용 목록 밖이다`);
      }
      const templates = [
        ...Object.entries(r?.labels ?? {}).map(([k, v]) => [`라벨 ${k}`, String(v)]),
        ...(r?.alert ? Object.entries(r?.annotations ?? {}).map(([k, v]) => [`주석 ${k}`, String(v)]) : []),
      ];
      for (const [what, text] of templates) {
        for (const m of text.matchAll(/(?:\$labels|\.Labels)\.([A-Za-z_]\w*)/g)) if (!allowedLabel(m[1])) add(`${where}: ${what}이 읽는 $labels.${m[1]}가 허용 목록 밖이다`);
        if (/(?:\$labels|\.Labels)(?!\.[A-Za-z_])/.test(text)) add(`${where}: ${what}이 라벨 전체($labels)를 싣는다(docs/observability.md §5 '경보 규칙 검사')`);
      }

      if (!r?.alert) continue;
      alerts++;
      const labels = r.labels ?? {};
      const ann = r.annotations ?? {};
      // 주석: summary·runbook_url·dashboard_url, kind slo는 explore_url도
      const need = ['summary', 'runbook_url', 'dashboard_url', ...(labels.kind === 'slo' ? ['explore_url'] : [])];
      for (const k of need) if (typeof ann[k] !== 'string' || !ann[k].trim()) add(`${where}: 주석 ${k}가 없거나 비었다(docs/observability.md §5 '경보 규칙 검사')`);
      // 주석 글의 2차 마스킹 꼴(틀 표현을 뺀 글자)
      for (const [k, v] of Object.entries(ann)) {
        const plain = String(v).replace(/\{\{[\s\S]*?\}\}/g, ' ');
        for (const p of pii) if (p.re.test(plain)) add(`${where}: 주석 ${k}에 이용자 식별값 꼴(${p.name}, ${PII})이 있다`);
      }
      // 라벨 값: severity·kind
      const sev = labels.severity;
      if (sev === undefined) add(`${where}: severity 라벨이 없다`);
      else if (sev === 'none') {
        if (!amNames.has(r.alert)) add(`${where}: severity none은 Alertmanager 설정(${ALERTMANAGER})에 경보 이름 경로가 있을 때만 쓴다`);
      } else if (!canon.severities.has(String(sev))) add(`${where}: severity ${sev}가 목록(${[...canon.severities].join('·')}) 밖이다`);
      if (labels.kind === undefined) add(`${where}: kind 라벨이 없다`);
      else if (!canon.kinds.has(String(labels.kind))) add(`${where}: kind ${labels.kind}가 목록(${[...canon.kinds].join('·')}) 밖이다`);
    }
  }

  // 간격 ②: INPUT_STALE_MS ≥ 자동 제어가 읽는 이름의 간격 가운데 가장 긴 것 × 3
  let longest = 0;
  let longestName = '';
  for (const n of [...control.names, ...control.opaque]) {
    const ms = recordMs.has(n) ? recordMs.get(n) : sloFastMs;
    if (ms > longest) [longest, longestName] = [ms, n];
  }
  if (staleMs < STALE_FACTOR * longest) {
    add(`${PLAN_TS}: INPUT_STALE_MS: 입력 없음 판정 ${showMs(staleMs)}가 자동 제어 입력(${CONTROL_TS}의 CONTROL_QUERIES) 가운데 가장 긴 간격 ${showMs(longest)}(${longestName})의 ${STALE_FACTOR}배(${showMs(STALE_FACTOR * longest)})보다 짧다(docs/observability.md §4 간격 규칙 ②)`);
  }

  // 간격 ③: 규칙 시험의 입력 간격과 평가 간격
  const tests = yamlFiles(join(root, TEST_DIR)).filter((f) => /\.test\.ya?ml$/.test(f));
  const testGroupsByFile = new Map();
  for (const f of tests) {
    const rel = `${TEST_DIR}/${f}`;
    const spec = readYaml(root, rel);
    const names = (Array.isArray(spec?.tests) ? spec.tests : []).map((t) => t?.name);
    testGroupsByFile.set(rel, new Set(names));
    const evalText = spec?.evaluation_interval === undefined ? PROMETHEUS_DEFAULT_INTERVAL : String(spec.evaluation_interval);
    const evalMs = durationMs(evalText);
    const ruleIntervals = new Set();
    for (const rf of Array.isArray(spec?.rule_files) ? spec.rule_files : []) {
      for (const [key, ms] of groupIntervals) if (key.startsWith(`${toPosix(String(rf))}#`)) ruleIntervals.add(ms);
    }
    if (evalMs === null || !ruleIntervals.has(evalMs)) {
      add(`${rel}: evaluation_interval: 평가 간격 ${evalText}가 rule_files 묶음의 평가 간격(${[...ruleIntervals].map(showMs).join('·') || '없음'}) 가운데 하나가 아니다(docs/observability.md §4 간격 규칙 ③)`);
    }
    for (const t of Array.isArray(spec?.tests) ? spec.tests : []) {
      const name = t?.name ?? '(이름 없음)';
      const exception = exceptions.find((e) => toPosix(String(e?.file ?? '')) === rel && e?.test === name && typeof e?.reason === 'string' && e.reason.trim());
      if (exception) continue;
      const intervalText = t?.interval === undefined ? evalText : String(t.interval);
      const ms = durationMs(intervalText);
      const bad = [];
      for (const s of Array.isArray(t?.input_series) ? t.input_series : []) {
        const series = String(s?.series ?? '');
        const metric = /^\s*([a-zA-Z_:][\w:]*)/.exec(series)?.[1] ?? /__name__\s*=\s*"([^"]+)"/.exec(series)?.[1] ?? '(이름 없음)';
        const want = recordMs.has(metric) ? [recordMs.get(metric)] : [sloFastMs, otherScrapeMs];
        if (ms === null || !want.includes(ms)) bad.push(`${metric}: ${want.map(showMs).join('·')}`);
      }
      if (bad.length) add(`${rel}: ${name}: 입력 간격 ${intervalText}가 운영 간격과 다르다(${[...new Set(bad)].join(', ')}; docs/observability.md §4 간격 규칙 ③, 예외는 ${CONFIG})`);
    }
  }
  // 예외 목록: 그 시험 묶음이 있고 까닭이 비지 않아야 한다
  for (const e of exceptions) {
    const name = String(e?.test ?? '(이름 없음)');
    const file = toPosix(String(e?.file ?? ''));
    if (!testGroupsByFile.get(file)?.has(e?.test)) add(`${CONFIG}: ${name}: 예외의 시험 묶음이 ${file || '(파일 없음)'}에 없다(낡은 예외)`);
    if (typeof e?.reason !== 'string' || !e.reason.trim()) add(`${CONFIG}: ${name}: 예외의 까닭(reason)이 비었다`);
  }

  // V-T16: 서비스 템플릿 칸 목록 = 표준 칸 목록(같은 값, 같은 차례)
  const sameList = (a, b) => a.length === b.length && a.every((x, i) => sameNumber(x, b[i]));
  if (!sameList(templateBuckets, canon.standard)) {
    add(`${METRICS}: LATENCY_BUCKETS_SECONDS: 칸 목록 [${templateBuckets.join(', ')}]이 표준 칸 목록 [${canon.standard.join(', ')}](${DOC} §8)과 다르다`);
  }
  // V-T16: Envoy histogram_bucket_settings(밀리초) = 표준 칸 목록 × 1000
  const envoy = [];
  const walkDir = (abs) => {
    if (!existsSync(abs)) return;
    for (const ent of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(abs, ent.name);
      if (ent.isDirectory()) walkDir(p);
      else if (/\.ya?ml$/.test(ent.name)) envoy.push(toPosix(relative(root, p)));
    }
  };
  walkDir(join(root, GATEWAYS));
  const standardMs = canon.standard.map((x) => Math.round(x * 1000 * 1e6) / 1e6);
  let found = 0;
  for (const rel of envoy) {
    const docs = readYamlDocs(root, rel);
    const visit = (node, path) => {
      if (Array.isArray(node)) node.forEach((x, i) => visit(x, `${path}[${i}]`));
      else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (k === 'histogram_bucket_settings') {
            for (const [i, setting] of (Array.isArray(v) ? v : [v]).entries()) {
              found++;
              const buckets = Array.isArray(setting?.buckets) ? setting.buckets.map(Number) : [];
              if (!sameList(buckets, standardMs)) add(`${rel}: ${path}.histogram_bucket_settings[${i}].buckets: 칸 [${buckets.join(', ')}](밀리초)가 표준 칸 목록 × 1000 [${standardMs.join(', ')}]과 다르다`);
            }
          } else visit(v, path ? `${path}.${k}` : k);
        }
      }
    };
    docs.forEach((d, i) => visit(d, `문서 ${i + 1}`));
  }
  if (!found) notes.push(`없음: Envoy 히스토그램 칸 설정(${GATEWAYS}/에 histogram_bucket_settings가 없다, ADR-0382)`);

  return { violations, notes, counts: { files: files.length, groups: groups.length, alerts, tests: tests.length } };
}

/** 위반 글 목록('<저장소 기준 경로>: <이름>: <까닭>', 빈 배열이면 통과). 읽지 못하면 Error를 던진다 */
export function checkAlerts(root) {
  return inspect(root).violations;
}

/** @param {string[]} argv @returns {number} */
export function main(argv) {
  try {
    const { root } = parseArgs(argv);
    const { violations, notes, counts } = inspect(root);
    for (const n of notes) console.log(n);
    for (const v of violations) console.log(`막음: ${v}`);
    const what = `규칙 파일 ${counts.files}개(묶음 ${counts.groups}개, 경보 ${counts.alerts}개)·규칙 시험 파일 ${counts.tests}개`;
    if (violations.length) {
      console.log(`alert-check: ${what}에서 ${violations.length}건 막음`);
      return 1;
    }
    console.log(`alert-check: ${what} 통과`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`alert-check: ${e.message}\n${USAGE}`);
      return 2;
    }
    throw e;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`alert-check: 뜻밖의 오류: ${e?.stack ?? e}`);
    process.exitCode = 2;
  }
}
