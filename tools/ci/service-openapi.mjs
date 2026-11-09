// 서비스 OpenAPI 차이 검사(D-T38, docs/devops.md §3.1 contract-check, openspec 변경 add-service-template 결정 7).
// 서비스가 @nestjs/swagger로 뽑은 문서(@peaket/platform emitOpenApi)를 계약(docs/api/openapi.yaml)과 견준다.
// 서비스는 package.json의 peaket.contractOperations에 맡는 계약 작업을 "<메서드> <경로>"로 적고,
// 그 작업만 경로·메서드·매개변수·요청과 응답 본문의 모양으로 견준다. 설명·예시·형식·길이·범위는 보지 않는다.
// contract-breaking.mjs services가 부른다.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONTRACT = 'docs/api/openapi.yaml';
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];
const OP = /^(GET|PUT|POST|DELETE|PATCH|HEAD|OPTIONS|TRACE) (\/\S*)$/;

/** 서비스 OpenAPI 차이(D-T38)의 대상: services/<이름>/package.json에 openapi:emit 스크립트가 있는 서비스 */
export function serviceTargets(root) {
  const dir = join(root, 'services');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => !!readPackage(join(dir, e.name))?.scripts?.['openapi:emit'])
    .map((e) => `services/${e.name}`)
    .sort();
}

function readPackage(dir) {
  const p = join(dir, 'package.json');
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return undefined;
  }
}

/** 맡는 작업 목록 읽기: 형식이 틀린 줄과 겹친 줄은 오류로 */
export function parseOperations(list) {
  const operations = [];
  const errors = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw !== 'string' || !OP.test(raw)) {
      errors.push(`맡는 작업은 "<대문자 메서드> <경로>"로 적는다: ${JSON.stringify(raw)}`);
      continue;
    }
    if (operations.includes(raw)) {
      errors.push(`맡는 작업이 겹친다: ${raw}`);
      continue;
    }
    operations.push(raw);
  }
  return { operations, errors };
}

/** 계약 읽기. JSON이면 그대로, 아니면 계약 패키지의 yaml 해석기로(CI 계약 잡은 작업 공간을 설치한 뒤 돈다) */
export function readContract(root) {
  const text = readFileSync(join(root, CONTRACT), 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    const require = createRequire(join(root, 'packages', 'contracts', 'package.json'));
    return require('yaml').parse(text);
  }
}

// ── 모양 ────────────────────────────────────────────────────────────────

function resolver(doc) {
  return (ref) => {
    if (typeof ref !== 'string' || !ref.startsWith('#/')) throw new Error(`이 문서 안을 가리키지 않는 $ref: ${ref}`);
    let node = doc;
    for (const part of ref.slice(2).split('/')) {
      node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
      if (node === undefined) throw new Error(`$ref를 찾지 못했다: ${ref}`);
    }
    return node;
  };
}

/** $ref를 따라간 객체(설명 같은 형제 칸은 3.1에서 허용되지만 모양에는 안 쓴다) */
function deref(node, resolve, seen = new Set()) {
  let cur = node;
  while (cur && typeof cur === 'object' && typeof cur.$ref === 'string') {
    if (seen.has(cur.$ref)) break;
    seen.add(cur.$ref);
    cur = resolve(cur.$ref);
  }
  return cur;
}

/** $ref를 따라가며 지나온 $ref를 쌓는다. 이미 지나온 것을 다시 만나면 순환으로 멈춘다 */
function unwrapRef(node, resolve, stack) {
  let cur = node;
  let st = stack;
  while (cur && typeof cur === 'object' && typeof cur.$ref === 'string') {
    if (st.includes(cur.$ref)) return { recursive: cur.$ref.split('/').pop() };
    st = [...st, cur.$ref];
    cur = resolve(cur.$ref);
  }
  return { node: cur, stack: st };
}

const uniqSorted = (xs) => [...new Set(xs)].sort();
const isObj = (m) => !!m && typeof m === 'object' && !Array.isArray(m);
const STRUCTURE = ['properties', 'items', 'additionalProperties', 'anyOf', 'oneOf', 'allOf', '$ref'];

/** 적힌 형(nullable·null 값 포함). 형이 없으면 열거 값에서 읽는다 */
function typesOf(s) {
  const t = [];
  if (Array.isArray(s.type)) t.push(...s.type);
  else if (typeof s.type === 'string') t.push(s.type);
  if (s.nullable === true) t.push('null');
  const values = Array.isArray(s.enum) ? s.enum : s.const !== undefined ? [s.const] : [];
  if (values.includes(null)) t.push('null');
  if (s.type === undefined) {
    for (const v of values) if (v !== null) t.push(typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v);
  }
  return t;
}

/** null만 받는 조각: {type: null}, {type: 'string', nullable: true, enum: [null]}, {nullable: true, enum: [null]} 등(Zod 4 toJSONSchema 출력) */
const isNullOnly = (m) =>
  isObj(m) &&
  !STRUCTURE.some((k) => k in m) &&
  ((Array.isArray(m.enum) && m.enum.length > 0 && m.enum.every((v) => v === null)) ||
    (m.type === 'null' && m.enum === undefined) ||
    (Array.isArray(m.type) && m.type.length > 0 && m.type.every((x) => x === 'null') && m.enum === undefined));

/** 형만 있는 스칼라 조각(Zod는 z.union([z.string(), z.number()])을 이런 조각들의 anyOf로 낸다) */
const isPlainScalar = (m) =>
  isObj(m) && !STRUCTURE.some((k) => k in m) && m.enum === undefined && m.const === undefined &&
  typesOf(m).length > 0 && typesOf(m).every((t) => ['string', 'number', 'integer', 'boolean', 'null'].includes(t));

/** 값 목록 조각: 열거나 const만 있는 스칼라(Zod는 값 목록 union을 값 하나짜리 열거들의 anyOf로 낸다) */
const isLiteral = (m) => isObj(m) && !STRUCTURE.some((k) => k in m) && (Array.isArray(m.enum) || m.const !== undefined);

/**
 * 견줄 모양: type(nullable·null 값 → null), properties, required, items, enum(const 포함), 조합(oneOf는 anyOf로), 객체형 additionalProperties.
 * 같은 뜻의 다른 표기(3.1 type 배열과 3.0 nullable, null 조각이 낀 anyOf, 하나짜리 allOf, 값 목록 union과 열거 하나)는 같은 모양이 된다
 */
export function shapeOf(schema, resolve, stack = [], dir = undefined) {
  if (schema === true || schema === undefined || schema === null) return { any: true };
  if (schema === false) return { never: true };
  const top = unwrapRef(schema, resolve, stack);
  if (top.recursive) return { recursive: top.recursive };
  let st = top.stack;
  let s = { ...top.node };
  let recursive;
  const types = [];
  // 조각 하나를 감싼 칸에 합친다(감싼 쪽의 nullable 같은 칸이 이긴다)
  const absorb = (member) => {
    const inner = unwrapRef(member, resolve, st);
    if (inner.recursive) {
      recursive = inner.recursive;
      return;
    }
    st = inner.stack;
    s = { ...inner.node, ...s };
  };
  const union = [];
  // 합친 조각이 또 조합을 가져올 수 있어(Zod z.union([z.union([A, B]), z.null()]), 조합이 없어질 때까지 되풀이한다(다시 본 리뷰)
  for (let guard = 0; guard < 64; guard++) {
    // allOf 하나짜리는 그 안의 것과 같다(@nestjs/swagger가 $ref를 감쌀 때 쓴다)
    if (Array.isArray(s.allOf) && s.allOf.length === 1) {
      const m = s.allOf[0];
      delete s.allOf;
      absorb(m);
      continue;
    }
    const key = Array.isArray(s.anyOf) ? 'anyOf' : Array.isArray(s.oneOf) ? 'oneOf' : null;
    if (!key) break;
    const members = s[key];
    delete s[key];
    const rest = [];
    for (const m of members) {
      const r = unwrapRef(m, resolve, st);
      if (!r.recursive && isNullOnly(r.node)) types.push('null');
      else rest.push(m);
    }
    const nodes = rest.map((m) => unwrapRef(m, resolve, st));
    if (rest.length === 1) absorb(rest[0]);
    else if (rest.length > 1 && nodes.every((r) => !r.recursive && isLiteral(r.node))) {
      for (const r of nodes) types.push(...typesOf({ ...r.node, enum: undefined, const: undefined }));
      s.enum = [...(Array.isArray(s.enum) ? s.enum : []), ...nodes.flatMap((r) => (Array.isArray(r.node.enum) ? r.node.enum : [r.node.const]))];
    } else if (rest.length > 1 && nodes.every((r) => !r.recursive && isPlainScalar(r.node))) {
      for (const r of nodes) types.push(...typesOf(r.node));
    } else union.push(...rest);
  }
  types.push(...typesOf(s));
  if (!types.some((t) => t !== 'null')) {
    if (s.properties) types.push('object');
    else if (s.items) types.push('array');
  }
  const values = Array.isArray(s.enum) ? s.enum : s.const !== undefined ? [s.const] : null;
  // 숫자 열거는 값으로 형을 읽는다(값이 모두 정수면 integer, 아니면 number. Zod는 값마다 number·integer를 섞어 낸다)
  const nums = (values ?? []).filter((v) => typeof v === 'number');
  if (nums.length && nums.length === (values ?? []).filter((v) => v !== null).length) {
    const numType = nums.every(Number.isInteger) ? 'integer' : 'number';
    for (let i = types.length - 1; i >= 0; i--) if (types[i] === 'integer' || types[i] === 'number') types.splice(i, 1);
    types.push(numType);
  }
  // 요청에서는 읽기 전용 칸, 응답에서는 쓰기 전용 칸을 뺀다(OpenAPI readOnly·writeOnly, 생성 Zod도 요청 본문에서 읽기 전용 칸을 뺀다)
  const hidden = (p) => {
    const r = unwrapRef(p, resolve, st);
    const n = r.recursive ? {} : r.node ?? {};
    return (dir === 'request' && (p?.readOnly === true || n.readOnly === true)) || (dir === 'response' && (p?.writeOnly === true || n.writeOnly === true));
  };
  const props = s.properties ? Object.keys(s.properties).filter((k) => !hidden(s.properties[k])).sort() : null;
  const out = {};
  if (recursive) out.recursive = recursive;
  if (types.length) out.type = uniqSorted(types);
  if (props) out.properties = Object.fromEntries(props.map((k) => [k, shapeOf(s.properties[k], resolve, st, dir)]));
  if (out.type?.includes('object') || s.properties) out.required = uniqSorted((s.required ?? []).filter((k) => !props || props.includes(k) || !(k in s.properties)));
  if (s.items !== undefined) out.items = shapeOf(s.items, resolve, st, dir);
  if (values) out.enum = uniqSorted(values.filter((v) => v !== null).map((v) => JSON.stringify(v)));
  const sorted = (list) => list.map((m) => shapeOf(m, resolve, st, dir)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (union.length) out.anyOf = sorted(union);
  if (Array.isArray(s.allOf)) out.allOf = sorted(s.allOf);
  if (isObj(s.additionalProperties)) out.additionalProperties = shapeOf(s.additionalProperties, resolve, st, dir);
  // 요청 본문 객체의 닫힘(additionalProperties: false). 계약은 요청을 닫고 응답은 열며(docs/api/guidelines.md §1, BAS-040),
  // 서비스의 응답 직렬화 스키마는 정의 밖 칸을 버리려고 닫을 수 있어 응답 쪽은 견주지 않는다
  // { not: {} }(Zod never, 예: 빈 객체만 받는 record(string, never))도 닫힘이다
  const never = (x) => x === false || (isObj(x) && Object.keys(x).length === 1 && isObj(x.not) && Object.keys(x.not).length === 0);
  if (dir === 'request' && (out.type?.includes('object') || s.properties)) out.closed = never(s.additionalProperties);
  return out;
}

function diffShape(c, v, path, out) {
  const j = (x) => JSON.stringify(x);
  if (j(c.type) !== j(v.type)) out.push(`${path}: 형이 다르다(계약 ${j(c.type ?? [])}, 서비스 ${j(v.type ?? [])})`);
  if (c.properties || v.properties) {
    const cp = c.properties ?? {};
    const vp = v.properties ?? {};
    for (const k of Object.keys(vp)) if (!(k in cp)) out.push(`${path}.${k}: 계약에 없는 칸`);
    for (const k of Object.keys(cp)) if (!(k in vp)) out.push(`${path}.${k}: 서비스에 없는 칸`);
    for (const k of Object.keys(cp)) if (k in vp) diffShape(cp[k], vp[k], `${path}.${k}`, out);
  }
  if (j(c.required) !== j(v.required)) out.push(`${path}: 필수 칸이 다르다(계약 ${j(c.required ?? [])}, 서비스 ${j(v.required ?? [])})`);
  if (c.items || v.items) diffShape(c.items ?? {}, v.items ?? {}, `${path}[]`, out);
  if (j(c.enum) !== j(v.enum)) out.push(`${path}: 열거 값이 다르다(계약 ${c.enum?.join(',') ?? '없음'}, 서비스 ${v.enum?.join(',') ?? '없음'})`);
  for (const key of ['anyOf', 'allOf']) {
    if (j(c[key]) === j(v[key])) continue;
    // 같은 개수면 원소끼리 견줘 어긋난 곳을 보인다(원소는 모양 순으로 늘어서 있다)
    if (Array.isArray(c[key]) && Array.isArray(v[key]) && c[key].length === v[key].length) c[key].forEach((x, i) => diffShape(x, v[key][i], `${path}.${key}[${i}]`, out));
    else out.push(`${path}: ${key}가 다르다(계약 ${c[key]?.length ?? 0}개, 서비스 ${v[key]?.length ?? 0}개)`);
  }
  if (c.additionalProperties || v.additionalProperties) diffShape(c.additionalProperties ?? {}, v.additionalProperties ?? {}, `${path}{*}`, out);
  if ((c.closed !== undefined || v.closed !== undefined) && !!c.closed !== !!v.closed) {
    out.push(`${path}: 닫힘이 다르다(계약 ${c.closed ? '닫힘' : '열림'}, 서비스 ${v.closed ? '닫힘' : '열림'})`);
  }
  for (const flag of ['any', 'never', 'recursive']) if (j(c[flag]) !== j(v[flag])) out.push(`${path}: 모양이 다르다(${flag})`);
}

function compareSchema(cSchema, cResolve, vSchema, vResolve, where, out, dir) {
  const diffs = [];
  diffShape(shapeOf(cSchema, cResolve, [], dir), shapeOf(vSchema, vResolve, [], dir), '$', diffs);
  for (const d of diffs) out.push(`${where}: ${d}`);
}

// ── 작업 비교 ─────────────────────────────────────────────────────────────

function operationsOf(doc) {
  const ops = new Map();
  for (const [path, item] of Object.entries(doc?.paths ?? {})) {
    for (const m of METHODS) if (item?.[m]) ops.set(`${m.toUpperCase()} ${path}`, { item, op: item[m] });
  }
  return ops;
}

function paramsOf({ item, op }, resolve) {
  const map = new Map();
  for (const raw of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
    const p = deref(raw, resolve);
    if (!p?.name || !p?.in) continue;
    const name = p.in === 'header' ? p.name.toLowerCase() : p.name;
    map.set(`${p.in} ${name}`, { required: p.in === 'path' ? true : p.required === true, schema: p.schema });
  }
  return map;
}

const contentOf = (node, resolve) => deref(node, resolve)?.content ?? {};

function compareContent(cContent, cResolve, vContent, vResolve, where, out, { mustMatchTypes, dir }) {
  const ct = Object.keys(cContent).sort();
  const vt = Object.keys(vContent).sort();
  if (mustMatchTypes && ct.join() !== vt.join()) out.push(`${where}: 내용 형식이 다르다(계약 ${ct.join(',') || '없음'}, 서비스 ${vt.join(',') || '없음'})`);
  for (const t of vt) {
    if (!(t in cContent)) {
      if (!mustMatchTypes) out.push(`${where} ${t}: 계약에 없는 내용 형식`);
      continue;
    }
    compareSchema(cContent[t].schema, cResolve, vContent[t].schema, vResolve, `${where} ${t}`, out, dir);
  }
}

function compareOperation(key, c, cResolve, v, vResolve, out) {
  // 매개변수
  const cp = paramsOf(c, cResolve);
  const vp = paramsOf(v, vResolve);
  for (const k of vp.keys()) if (!cp.has(k)) out.push(`${key} 매개변수 ${k}: 계약에 없는 매개변수`);
  for (const k of cp.keys()) if (!vp.has(k)) out.push(`${key} 매개변수 ${k}: 서비스에 없는 매개변수`);
  for (const [k, cv] of cp) {
    const vv = vp.get(k);
    if (!vv) continue;
    if (cv.required !== vv.required) out.push(`${key} 매개변수 ${k}: 필수 여부가 다르다(계약 ${cv.required}, 서비스 ${vv.required})`);
    compareSchema(cv.schema, cResolve, vv.schema, vResolve, `${key} 매개변수 ${k}`, out, 'request');
  }
  // 요청 본문
  const cb = deref(c.op.requestBody, cResolve);
  const vb = deref(v.op.requestBody, vResolve);
  if (!!cb !== !!vb) out.push(`${key} 요청 본문: ${cb ? '서비스에 없다' : '계약에 없다'}`);
  else if (cb) {
    if ((cb.required === true) !== (vb.required === true)) out.push(`${key} 요청 본문: 필수 여부가 다르다(계약 ${cb.required === true}, 서비스 ${vb.required === true})`);
    compareContent(cb.content ?? {}, cResolve, vb.content ?? {}, vResolve, `${key} 요청 본문`, out, { mustMatchTypes: true, dir: 'request' });
  }
  // 응답: 2xx 모음은 같아야 하고, 서비스가 적은 오류 응답은 계약에 있어야 한다
  const cr = c.op.responses ?? {};
  const vr = v.op.responses ?? {};
  const ok = (r) => Object.keys(r).filter((s) => /^2/.test(s)).sort();
  if (ok(cr).join() !== ok(vr).join()) out.push(`${key} 성공 응답 상태가 다르다(계약 ${ok(cr).join(',') || '없음'}, 서비스 ${ok(vr).join(',') || '없음'})`);
  for (const status of Object.keys(vr)) {
    if (!(status in cr)) {
      if (!/^2/.test(status)) out.push(`${key} 응답 ${status}: 계약에 없다`);
      continue;
    }
    const cc = contentOf(cr[status], cResolve);
    const vc = contentOf(vr[status], vResolve);
    // 오류 응답 본문은 공용 필터가 내는 Problem이라 서비스가 적지 않아도 된다. 적으면 모양이 같아야 한다
    if (!/^2/.test(status) && Object.keys(vc).length === 0) continue;
    compareContent(cc, cResolve, vc, vResolve, `${key} 응답 ${status}`, out, { mustMatchTypes: /^2/.test(status), dir: 'response' });
  }
}

/** 맡는 작업만 견준다. 어긋남마다 한 줄 */
export function compareService({ contract, emitted, owns }) {
  const out = [];
  const cResolve = resolver(contract);
  const vResolve = resolver(emitted);
  const cOps = operationsOf(contract);
  const vOps = operationsOf(emitted);
  for (const key of owns) {
    if (!cOps.has(key)) out.push(`${key}: 맡는 목록에 있는데 계약에 없다`);
    else if (!vOps.has(key)) out.push(`${key}: 맡는 목록에 있는데 서비스 문서에 없다`);
  }
  for (const key of vOps.keys()) {
    if (!cOps.has(key)) out.push(`${key}: 서비스 문서에 있는데 계약에 없다`);
    else if (!owns.includes(key)) out.push(`${key}: 서비스 문서에 있는데 맡는 목록에 없다(package.json peaket.contractOperations)`);
  }
  for (const key of owns) {
    if (cOps.has(key) && vOps.has(key)) compareOperation(key, cOps.get(key), cResolve, vOps.get(key), vResolve, out);
  }
  return out;
}

// ── 서비스마다 뽑아 견주기 ────────────────────────────────────────────────

/** 서비스의 openapi:emit을 부른다. 서비스는 환경 변수 OPENAPI_OUT의 경로에 문서를 쓴다 */
export async function pnpmEmit(serviceDir, out) {
  const r = spawnSync('pnpm', ['--dir', serviceDir, 'run', 'openapi:emit'], {
    env: { ...process.env, OPENAPI_OUT: out },
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`openapi:emit 종료 코드 ${r.status}: ${`${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-10).join(' / ')}`);
}

export async function checkServices({ cwd, emit = pnpmEmit }) {
  const failures = [];
  const checked = [];
  const targets = serviceTargets(cwd);
  if (!targets.length) return { failures, checked, targets };
  let contract;
  try {
    contract = readContract(cwd);
  } catch (e) {
    return { failures: [`계약 ${CONTRACT}을 읽지 못했다: ${e.message}`], checked, targets };
  }
  for (const svc of targets) {
    const pkg = readPackage(join(cwd, svc));
    const { operations, errors } = parseOperations(pkg?.peaket?.contractOperations);
    if (errors.length || !operations.length) {
      failures.push(`${svc}: package.json의 peaket.contractOperations(맡는 계약 작업 목록)가 없거나 틀렸다${errors.length ? `: ${errors.join('; ')}` : ''}`);
      continue;
    }
    const dir = mkdtempSync(join(tmpdir(), 'service-openapi-'));
    const out = join(dir, 'openapi.json');
    try {
      try {
        await emit(join(cwd, svc), out);
      } catch (e) {
        failures.push(`${svc}: 문서를 만들지 못했다: ${e.message}`);
        continue;
      }
      let emitted;
      try {
        emitted = JSON.parse(readFileSync(out, 'utf8'));
      } catch (e) {
        failures.push(`${svc}: 뽑은 문서를 읽지 못했다: ${e.message}`);
        continue;
      }
      let diffs;
      try {
        diffs = compareService({ contract, emitted, owns: operations });
      } catch (e) {
        diffs = [`견주지 못했다: ${e.message}`];
      }
      if (diffs.length) failures.push(...diffs.map((d) => `${svc}: ${d}`));
      else checked.push(svc);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return { failures, checked, targets };
}
