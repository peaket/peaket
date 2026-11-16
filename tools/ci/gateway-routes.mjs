#!/usr/bin/env node
// openapi → API 호스트 HTTPRoute 생성기(BUILD_ORDER HOT-410, docs/infra.md §4.1 '경로별 메서드·한도·게이트웨이 오류', D-T42,
// docs/security/asvs/delivery.md 3.5.3). 묶음 BAT-060 계획 §5 '공개 인터페이스'.
// 쓰는 법: node tools/ci/gateway-routes.mjs --write | --check [--root <폴더>]
//   --write  생성 파일 deploy/gateways/<게이트웨이>.routes.yaml을 쓴다
//   --check  쓰지 않고 견준다. 다르면 바뀐 파일 이름과 첫 차이 줄을 보이고 1로 끝난다
//   --root   저장소 뿌리(기본은 이 파일의 두 단계 위). 시험이 임시 폴더를 가리킬 때 쓴다
// 입력: <root>/docs/api/openapi.yaml, 라우트 원천 <root>/deploy/gateways/routes/<게이트웨이>.yaml
// 끝 코드: 0 같음·씀, 1 --check에서 다름, 2 멈춤(docs/infra.md §4.1 '생성기가 멈추는 경우', 까닭을 한 줄씩)·인자 오류
//
// 원천 규칙의 맞춤(matches)에는 경로만 적는다(메서드 없음). 경로 값은 openapi의 꼴(틀 {이름} 그대로)이다.
//   PathPrefix: 그 경로와 그 아래(빗금으로 이어지는) 계약 경로를 맡는다. Exact: 그 계약 경로 하나만 맡는다
//   (같은 앞부분 아래를 백엔드·정책이 다른 라우트로 나눌 때 쓴다. 예: /v1/events/{eventId}는 core-svc, 그 아래 holds는 purchase-svc).
// 생성 규칙은 원천 규칙마다 '그 앞부분 아래이면서 그 호스트가 받는 계약 경로'의 (경로, 메서드) 짝과 경로마다의 OPTIONS다.
// 경로 틀 {이름}은 빗금 없는 한 마디 [^/]+의 정규식, 틀이 없으면 Exact다. HEAD는 계약에 없으면 넣지 않는다.
// x-peaket-cdn-cache: true인 작업은 같은 원천 규칙에서 따로 규칙으로 모으고 X-Trace-Id를 붙이지 않는다(docs/api/guidelines.md §9).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments, stringify } from 'yaml';
import { runIfMain } from './entry.mjs';

/** 계약 작업의 메서드 차례(맞춤 조건의 차례도 이것을 따른다). OPTIONS는 경로마다 생성기가 더한다 */
const METHOD_ORDER = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
/** Gateway API v1(Envoy Gateway v1.10.0 설치 파일의 HTTPRoute CRD, 2026-11-16 확인): 라우트의 규칙 16, 규칙의 맞춤 64, 라우트의 맞춤 합 128 */
export const LIMITS = { rulesPerRoute: 16, matchesPerRule: 64, matchesPerRoute: 128 };
/** 생성 라우트의 원천 이름표(나뉜 라우트가 어느 원천에서 왔는지) */
export const ROUTE_LABEL = 'peaket.io/route';
/** TRACE 405 직접 응답 필터(deploy/gateways/00-common.yaml) */
const TRACE_FILTER = { type: 'ExtensionRef', extensionRef: { group: 'gateway.envoyproxy.io', kind: 'HTTPRouteFilter', name: 'peaket-trace-not-allowed' } };
/** 응답에 그 요청의 trace-id를 붙인다(Envoy 치환 명령, docs/infra.md §4.1 '추적 머리') */
const TRACE_ID_FILTER = { type: 'ResponseHeaderModifier', responseHeaderModifier: { set: [{ name: 'X-Trace-Id', value: '%TRACE_ID%' }] } };

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const methodRank = (m) => METHOD_ORDER.indexOf(m);

/** 키 차례를 고정한 JSON(해시가 입력 차례에 기대지 않게) */
function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

/** 정규식 글자를 이스케이프한다 */
const escapeRe = (s) => s.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
const TEMPLATE = /\{[^}/]+\}/;

/**
 * 계약 경로(틀 {이름} 포함)를 맞춤 조건의 경로로. 틀이 없으면 Exact, 있으면 틀마다 [^/]+인 정규식(나머지 글자는 글자 그대로)
 * @param {string} p
 */
export function pathMatchOf(p) {
  if (!TEMPLATE.test(p)) return { type: 'Exact', value: p };
  return {
    type: 'RegularExpression',
    value: p
      .split(/(\{[^}/]+\})/)
      .map((x) => (/^\{[^}/]+\}$/.test(x) ? '[^/]+' : escapeRe(x)))
      .join(''),
  };
}

/** 원천 경로(틀 포함)를 TRACE 라우트의 정규식으로: 그 경로와 그 아래 전부 */
function traceRegexOf(v) {
  const m = pathMatchOf(v);
  return `${m.type === 'Exact' ? escapeRe(v) : m.value}(/.*)?`;
}

/**
 * 경로를 받는 호스트들(경로 servers가 이기고, 없으면 x-peaket-gateways의 위에서 처음 맞는 규칙)
 * @param {Record<string, any>} openapi @param {string} path
 */
export function hostsOf(openapi, path) {
  const item = openapi.paths?.[path] ?? {};
  const urls = Array.isArray(item.servers) && item.servers.length ? item.servers.map((s) => s?.url) : [(openapi['x-peaket-gateways']?.rules ?? []).find((r) => path.startsWith(r.prefix))?.server];
  const out = [];
  for (const u of urls.filter(Boolean)) {
    try {
      out.push(new URL(u).host);
    } catch {
      /* 주소가 아니면 건너뛴다 */
    }
  }
  return out;
}

/** 원천 맞춤 하나가 계약 경로를 맡는가 */
function claims(type, v, path) {
  if (type === 'Exact') return path === v;
  if (v === '/') return true;
  return path === v || path.startsWith(v.endsWith('/') ? v : `${v}/`);
}

/** 계약 경로의 작업 메서드(차례 고정)와 CDN 캐시 표시 */
function operationsOf(item) {
  return METHOD_ORDER.filter((m) => m !== 'OPTIONS' && item?.[m.toLowerCase()]).map((m) => ({ method: m, cdn: item[m.toLowerCase()]?.['x-peaket-cdn-cache'] === true }));
}

/** 맞춤 조건 목록을 경로 글자 차례 → 메서드 차례로 */
const sortMatches = (ms) => ms.sort((a, b) => byText(a.path.value, b.path.value) || methodRank(a.method) - methodRank(b.method));

/** 목록을 n개씩 */
function chunks(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/** 규칙의 요청 머리 고치기에서 x-peaket-app 값 */
function appOf(rule) {
  for (const f of rule?.filters ?? []) if (f.type === 'RequestHeaderModifier') for (const h of f.requestHeaderModifier?.set ?? []) if (String(h.name).toLowerCase() === 'x-peaket-app') return h.value;
  return undefined;
}

/** 라우트 하나의 메타데이터(이름·네임스페이스·이름표) */
function metadataOf(src, name, label) {
  const md = { name };
  if (src.metadata?.namespace) md.namespace = src.metadata.namespace;
  md.labels = { ...(clone(src.metadata?.labels) ?? {}), [ROUTE_LABEL]: label };
  if (src.metadata?.annotations) md.annotations = clone(src.metadata.annotations);
  return md;
}

/** spec에서 rules 밖의 칸(parentRefs·hostnames 등)을 원천 차례대로 */
function specWithout(src) {
  const out = {};
  for (const [k, v] of Object.entries(src.spec ?? {})) if (k !== 'rules') out[k] = clone(v);
  return out;
}

/**
 * 규칙들을 라우트로 나눈다(규칙 16·맞춤 합 128). 이름은 원천 이름, -2, -3 …
 * @param {Record<string, any>} src @param {Array<Record<string, any>>} rules
 */
function packRoutes(src, rules) {
  const groups = [];
  let cur = [];
  let total = 0;
  for (const r of rules) {
    const n = r.matches.length;
    if (cur.length && (cur.length >= LIMITS.rulesPerRoute || total + n > LIMITS.matchesPerRoute)) {
      groups.push(cur);
      cur = [];
      total = 0;
    }
    cur.push(r);
    total += n;
  }
  if (cur.length) groups.push(cur);
  const base = src.metadata.name;
  return groups.map((g, i) => ({
    apiVersion: src.apiVersion ?? 'gateway.networking.k8s.io/v1',
    kind: 'HTTPRoute',
    metadata: metadataOf(src, i === 0 ? base : `${base}-${i + 1}`, base),
    spec: { ...specWithout(src), rules: g },
  }));
}

/** 원천 규칙 하나에서 생성 규칙(맞춤 64개씩) 만들기 */
function rulesFrom(srcRule, matches, withTraceId, suffix) {
  const { matches: _m, filters, name, ...rest } = srcRule;
  void _m;
  return chunks(matches, LIMITS.matchesPerRule).map((ms, i) => {
    const rule = {};
    if (name) rule.name = `${name}${suffix}${i ? `-${i + 1}` : ''}`;
    rule.matches = ms;
    const fs = clone(filters ?? []);
    if (withTraceId) fs.push(clone(TRACE_ID_FILTER));
    if (fs.length) rule.filters = fs;
    for (const [k, v] of Object.entries(rest)) rule[k] = clone(v);
    return rule;
  });
}

/**
 * openapi와 라우트 원천으로 생성 파일들을 만든다.
 * @param {{ openapi: Record<string, any>, sources: Record<string, Array<Record<string, any>>> }} input
 *   openapi: 해석한 openapi 객체. sources: 게이트웨이 이름(gw-fan 등) → 그 원천 파일의 HTTPRoute 객체 목록
 * @returns {{ files: Map<string, string>, problems: string[] }} files: 저장소 뿌리 기준 상대 경로(deploy/gateways/<게이트웨이>.routes.yaml) → 글,
 *   problems: 멈추는 까닭(한 줄씩, 비면 멈추지 않음)
 */
export function generateRoutes(input) {
  const { openapi, sources } = input ?? {};
  const problems = [];
  const files = new Map();
  if (!openapi || typeof openapi !== 'object' || !openapi.paths || typeof openapi.paths !== 'object') return { files, problems: ['openapi에 paths가 없다'] };
  const contractPaths = Object.keys(openapi.paths).sort(byText);
  if (!contractPaths.length) problems.push('openapi에 계약 경로가 하나도 없다');
  if (!Object.keys(sources ?? {}).length) problems.push('라우트 원천이 하나도 없다');
  const version = String(openapi.info?.version ?? '');
  const hash = createHash('sha256').update(canonicalJson(openapi)).digest('hex');
  for (const p of contractPaths) if (openapi.paths[p]?.trace) problems.push(`계약 경로 ${p}에 TRACE 작업이 있다(모든 게이트웨이가 TRACE를 405로 거절한다)`);

  for (const gw of Object.keys(sources ?? {}).sort(byText)) {
    const routes = sources[gw] ?? [];
    const where = (r) => `${gw}/${r?.metadata?.name ?? '(이름 없음)'}`;
    if (!routes.length) {
      problems.push(`${gw}: 라우트 원천이 비었다`);
      continue;
    }
    for (const r of routes) {
      if (r?.kind !== 'HTTPRoute') problems.push(`${gw}: 원천에 HTTPRoute가 아닌 객체가 있다(${r?.kind})`);
      if (!r?.metadata?.name) problems.push(`${gw}: 이름 없는 원천 라우트`);
      if (r?.metadata?.name === `${gw}-trace`) problems.push(`${where(r)}: TRACE 라우트는 원천에 두지 않는다(생성기가 만든다)`);
    }
    const first = routes[0];
    const parentKey = JSON.stringify(first?.spec?.parentRefs ?? []);
    const hostKey = JSON.stringify(first?.spec?.hostnames ?? []);
    for (const r of routes) if (JSON.stringify(r?.spec?.parentRefs ?? []) !== parentKey || JSON.stringify(r?.spec?.hostnames ?? []) !== hostKey) problems.push(`${where(r)}: 한 원천 파일의 라우트는 부모·호스트가 같아야 한다(TRACE 라우트를 하나로 만든다)`);
    const hosts = new Set(routes.flatMap((r) => r?.spec?.hostnames ?? []));
    if (!hosts.size) problems.push(`${gw}: 원천 라우트에 호스트가 없다`);
    const onHost = (p) => hostsOf(openapi, p).some((h) => hosts.has(h));

    // 원천 규칙마다 맡는 계약 경로
    /** @type {Array<{ route: any, index: number, rule: any, paths: string[] }>} */
    const ruleClaims = [];
    for (const r of routes) {
      (r?.spec?.rules ?? []).forEach((rule, index) => {
        const at = `${where(r)} 규칙 ${index + 1}`;
        const ms = rule.matches ?? [];
        if (!ms.length) problems.push(`${at}: 맞춤(앞부분)이 없다`);
        const paths = new Set();
        for (const m of ms) {
          const v = m.path?.value;
          const type = m.path?.type ?? 'PathPrefix';
          if (typeof v !== 'string' || !v.startsWith('/')) {
            problems.push(`${at}: 경로 값이 없다(${JSON.stringify(m)})`);
            continue;
          }
          if (!['PathPrefix', 'Exact'].includes(type)) problems.push(`${at}: 원천 맞춤은 PathPrefix·Exact만 적는다(${type} ${v})`);
          if (m.method || m.headers || m.queryParams) problems.push(`${at}: 원천 맞춤에는 경로만 적는다(메서드는 계약이 정한다): ${v}`);
          if (v.toLowerCase().startsWith('/internal')) problems.push(`${where(r)}: /internal/로 시작하는 경로를 맡는다(${v}). 어느 게이트웨이도 라우트하지 않는다`);
          const mine = contractPaths.filter((p) => onHost(p) && claims(type, v, p));
          if (!mine.length) problems.push(`${where(r)}: 앞부분 ${v}가 맡는 계약 경로가 하나도 없다`);
          for (const p of mine) paths.add(p);
        }
        for (const f of rule.filters ?? []) if (f.type === 'ResponseHeaderModifier') problems.push(`${at}: 원천 규칙에 ResponseHeaderModifier를 두지 않는다(생성기가 X-Trace-Id를 붙인다)`);
        ruleClaims.push({ route: r, index, rule, paths: [...paths].sort(byText) });
      });
    }
    // 그 호스트가 받는 계약 경로마다 맡는 규칙이 정확히 하나
    for (const p of contractPaths) {
      if (!onHost(p) || operationsOf(openapi.paths[p]).length === 0) continue;
      const owners = ruleClaims.filter((c) => c.paths.includes(p));
      if (p.toLowerCase().startsWith('/internal/') && owners.length) problems.push(`${gw}: /internal/로 시작하는 경로를 맡는다(${p})`);
      if (owners.length === 0) problems.push(`${gw}: 계약 경로 ${p}를 맡는 원천 규칙이 없다(호스트 ${[...hosts].join(',')})`);
      if (owners.length > 1) problems.push(`${gw}: 계약 경로 ${p}를 두 규칙이 함께 맡는다(${owners.map((o) => `${o.route.metadata?.name} 규칙 ${o.index + 1}`).join(', ')})`);
    }
    if (problems.length) continue;

    // 생성: 원천 라우트마다 규칙(캐시하지 않는 작업 → CDN 캐시 작업 차례), 상한을 넘으면 나눈다
    const docs = [];
    for (const r of routes) {
      const generated = [];
      for (const c of ruleClaims.filter((x) => x.route === r)) {
        const other = [];
        const cdn = [];
        for (const p of c.paths) {
          const ops = operationsOf(openapi.paths[p]);
          if (!ops.length) continue;
          const pm = pathMatchOf(p);
          for (const o of ops) (o.cdn ? cdn : other).push({ path: { ...pm }, method: o.method });
          // 사전 요청(OPTIONS)은 경로마다 하나. 캐시하지 않는 작업이 있으면 그 규칙에 둔다
          (ops.some((o) => !o.cdn) ? other : cdn).push({ path: { ...pm }, method: 'OPTIONS' });
        }
        if (other.length) generated.push(...rulesFrom(c.rule, sortMatches(other), true, ''));
        if (cdn.length) generated.push(...rulesFrom(c.rule, sortMatches(cdn), false, '-cdn'));
      }
      docs.push(...packRoutes(r, generated));
    }
    // TRACE 405 라우트: 원천 경로 전부와 남은 경로(PathPrefix / 와 정규식 /.*)를 TRACE 조건으로(docs/infra.md §4.1 '호스트와 내부 경로')
    const values = [...new Set(routes.flatMap((r) => (r.spec?.rules ?? []).flatMap((rule) => (rule.matches ?? []).map((m) => m.path.value))))].sort(byText);
    const traceMatches = [
      ...values.map((v) => ({ path: { type: 'RegularExpression', value: traceRegexOf(v) }, method: 'TRACE' })),
      { path: { type: 'PathPrefix', value: '/' }, method: 'TRACE' },
      { path: { type: 'RegularExpression', value: '/.*' }, method: 'TRACE' },
    ];
    const app = appOf(first.spec?.rules?.[0]);
    const traceFilters = [...(app === undefined ? [] : [{ type: 'RequestHeaderModifier', requestHeaderModifier: { set: [{ name: 'x-peaket-app', value: app }] } }]), clone(TRACE_FILTER)];
    const trace = {
      apiVersion: first.apiVersion ?? 'gateway.networking.k8s.io/v1',
      kind: 'HTTPRoute',
      metadata: metadataOf({ metadata: { namespace: first.metadata?.namespace } }, `${gw}-trace`, `${gw}-trace`),
      spec: { parentRefs: clone(first.spec?.parentRefs ?? []), hostnames: clone(first.spec?.hostnames ?? []), rules: chunks(traceMatches, LIMITS.matchesPerRule).map((ms) => ({ matches: ms, filters: clone(traceFilters) })) },
    };
    const head = [
      `# 생성 파일이다. 손으로 고치지 않는다(원천 deploy/gateways/routes/${gw}.yaml과 docs/api/openapi.yaml에서 node tools/ci/gateway-routes.mjs --write가 만든다, docs/infra.md §4.1 '경로별 메서드 생성기')`,
      `# openapi info.version ${version} · 계약 sha256 ${hash}`,
    ];
    const body = [trace, ...docs].map((d) => `---\n${stringify(d, { lineWidth: 0 })}`).join('');
    files.set(`deploy/gateways/${gw}.routes.yaml`, `${head.join('\n')}\n${body}`);
  }
  if (problems.length) return { files: new Map(), problems: [...new Set(problems)] };
  return { files, problems };
}

/**
 * 손으로 쓴 정책이 나뉜 생성 라우트를 모두 고르는지(docs/infra.md §4.1 '생성기가 멈추는 경우'의 대안: 정책의 targetRefs에 나뉜 이름을 모두 적는다).
 * 한 원천(이름표)에서 나온 라우트 가운데 하나라도 targetRefs로 고른 정책은 나머지도 모두 골라야 한다(그 이름표의 targetSelectors가 있으면 된다).
 * 나뉘어 생긴 적 없는 이름(<원천>-<수>)을 고르는 것도 문제다(라우트가 줄었는데 정책이 남음)
 * @param {Map<string, string>} files generateRoutes의 files
 * @param {Array<Record<string, any>>} objects deploy/gateways/*.yaml(생성 파일 밖)의 객체들
 * @returns {string[]}
 */
export function policyProblems(files, objects) {
  const families = new Map();
  for (const text of files.values())
    for (const d of parseAllDocuments(text)) {
      const o = d.toJS();
      if (o?.kind !== 'HTTPRoute') continue;
      const label = o.metadata?.labels?.[ROUTE_LABEL] ?? o.metadata?.name;
      if (!families.has(label)) families.set(label, new Set());
      families.get(label).add(o.metadata.name);
    }
  const familyOf = new Map();
  for (const [label, names] of families) for (const n of names) familyOf.set(n, label);
  const out = [];
  for (const p of objects) {
    const refs = [...(p.spec?.targetRefs ?? []), ...(p.spec?.targetRef ? [p.spec.targetRef] : [])].filter((t) => t.kind === 'HTTPRoute');
    if (!refs.length) continue;
    const named = new Set(refs.map((t) => t.name));
    const selected = new Set((p.spec?.targetSelectors ?? []).filter((s) => s.kind === 'HTTPRoute').map((s) => s.matchLabels?.[ROUTE_LABEL]).filter(Boolean));
    for (const n of named) {
      const label = familyOf.get(n);
      const base = /^(.*)-\d+$/.exec(n)?.[1];
      if (!label && base && families.has(base)) out.push(`${p.kind}/${p.metadata?.name}: 생성되지 않은 라우트 ${n}를 고른다`);
      if (!label || selected.has(label)) continue;
      for (const sibling of [...families.get(label)].sort(byText)) if (!named.has(sibling)) out.push(`${p.kind}/${p.metadata?.name}: ${n}를 고르면서 같은 원천(${label})에서 나뉜 ${sibling}를 고르지 않는다`);
    }
  }
  return [...new Set(out)];
}

/** <root>/deploy/gateways/routes/*.yaml → 게이트웨이 이름 → HTTPRoute 객체 목록 */
export function readSources(root) {
  const dir = join(root, 'deploy', 'gateways', 'routes');
  if (!existsSync(dir)) throw new Error(`라우트 원천 폴더가 없다: ${dir}`);
  const out = {};
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort(byText)) {
    const list = [];
    for (const d of parseAllDocuments(readFileSync(join(dir, f), 'utf8'))) {
      if (d.errors.length) throw new Error(`${f}: ${d.errors[0].message}`);
      const o = d.toJS();
      if (o && typeof o === 'object') list.push(o);
    }
    out[f.replace(/\.ya?ml$/, '')] = list;
  }
  return out;
}

/** <root>/deploy/gateways/*.yaml 가운데 생성 파일이 아닌 것의 객체들 */
function readHandwritten(root) {
  const dir = join(root, 'deploy', 'gateways');
  const out = [];
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n) && !/\.routes\.ya?ml$/.test(n)).sort(byText))
    for (const d of parseAllDocuments(readFileSync(join(dir, f), 'utf8'))) {
      const o = d.toJS();
      if (o && typeof o === 'object') out.push(o);
    }
  return out;
}

/** 첫 차이 줄(1부터) */
function firstDiff(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return { line: i + 1, disk: x[i], want: y[i] };
  return null;
}

const USAGE = '쓰는 법: node tools/ci/gateway-routes.mjs --write | --check [--root <폴더>]';

/** @param {string[]} argv @returns {number} */
export function main(argv) {
  let mode;
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write' || a === '--check') {
      if (mode && mode !== a) {
        console.error(`gateway-routes: --write와 --check는 함께 쓰지 않는다\n${USAGE}`);
        return 2;
      }
      mode = a;
    } else if (a === '--root') {
      if (!argv[i + 1]) {
        console.error(`gateway-routes: --root 뒤에 폴더가 없다\n${USAGE}`);
        return 2;
      }
      root = resolve(argv[++i]);
    } else {
      console.error(`gateway-routes: 모르는 인자 ${a}\n${USAGE}`);
      return 2;
    }
  }
  if (!mode) {
    console.error(USAGE);
    return 2;
  }
  let openapi;
  let sources;
  try {
    openapi = parse(readFileSync(join(root, 'docs', 'api', 'openapi.yaml'), 'utf8'));
    sources = readSources(root);
  } catch (e) {
    console.error(`gateway-routes: 입력을 읽지 못했다: ${e.message}`);
    return 2;
  }
  const { files, problems } = generateRoutes({ openapi, sources });
  if (problems.length) {
    console.error(`gateway-routes: 멈춤(${problems.length}건, 생성 파일을 쓰지 않았다)`);
    for (const p of problems) console.error(`- ${p}`);
    return 2;
  }
  const policy = policyProblems(files, readHandwritten(root));
  if (mode === '--write') {
    for (const [rel, text] of files) writeFileSync(join(root, rel), text);
    console.log(`gateway-routes: ${files.size}개를 썼다(${[...files.keys()].join(', ')})`);
    for (const p of policy) console.error(`경고(정책을 고친다): ${p}`);
    return 0;
  }
  const diffs = [];
  for (const [rel, text] of files) {
    const file = join(root, rel);
    if (!existsSync(file)) {
      diffs.push(`${rel}: 생성 파일이 없다(node tools/ci/gateway-routes.mjs --write)`);
      continue;
    }
    const disk = readFileSync(file, 'utf8');
    if (disk === text) continue;
    const d = firstDiff(disk, text);
    diffs.push(`${rel}: 다시 만든 결과와 다르다(줄 ${d?.line}: 저장소 ${JSON.stringify(d?.disk ?? '(없음)')} / 생성 ${JSON.stringify(d?.want ?? '(없음)')})`);
  }
  const gatewaysDir = join(root, 'deploy', 'gateways');
  if (existsSync(gatewaysDir))
    for (const f of readdirSync(gatewaysDir).filter((n) => /\.routes\.ya?ml$/.test(n)).sort(byText)) {
      const rel = `deploy/gateways/${f}`;
      if (!files.has(rel)) diffs.push(`${rel}: 원천이 없는 생성 파일이다(원천 deploy/gateways/routes/${f.replace(/\.routes\.ya?ml$/, '.yaml')})`);
    }
  for (const p of policy) diffs.push(`정책: ${p}`);
  if (diffs.length) {
    console.error(`gateway-routes: 생성 대조 실패(${diffs.length}건). 원천이나 openapi·정책을 고친 뒤 --write로 다시 만든다`);
    for (const d of diffs) console.error(`- ${d}`);
    return 1;
  }
  console.log(`gateway-routes: 생성 파일 ${files.size}개가 openapi·원천과 같다`);
  return 0;
}

await runIfMain(import.meta.url, () => main(process.argv.slice(2)));
