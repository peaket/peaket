#!/usr/bin/env node
// Avro 사건 스키마 검사(docs/api/avro/README.md §1·§3, docs/streaming.md §2.6, docs/devops.md §3.1 contract-check, BUILD_ORDER BAS-030).
// ① 파일·이름·네임스페이스·열거 기본 기호를 본다. ② 지난 출시 태그의 스키마와 견줘 BACKWARD_TRANSITIVE에서 깨지는 변경을 막는다.
// ③ 선택한 레지스트리에 스키마를 등록해 호환 검사를 맡길 수 있다(CI는 운영 레지스트리에 닿지 않는다. 로컬 컨테이너만 쓴다).
// 쓰는 법: node tools/ci/avro-schema.mjs [--root docs/api/avro] [--base <git ref>] [--registry <url> --topic-map <json>]
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UNKNOWN_SYMBOL = 'UNRECOGNIZED';
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(HERE, '..', '..', 'docs', 'api', 'avro');

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const typeName = (t) => (typeof t === 'string' ? t : Array.isArray(t) ? t.map(typeName).join('|') : isObject(t) ? t.name ?? typeName(t.type) : String(t));
const sameType = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 스키마 안의 이름 붙은 타입(레코드·열거)을 차례로 모은다 */
export function namedTypesOf(schema, out = []) {
  if (Array.isArray(schema)) {
    for (const s of schema) namedTypesOf(s, out);
  } else if (isObject(schema)) {
    if (schema.type === 'record' || schema.type === 'enum' || schema.type === 'fixed') out.push(schema);
    if (schema.type === 'record') for (const f of schema.fields ?? []) namedTypesOf(f.type, out);
    if (schema.type === 'array') namedTypesOf(schema.items, out);
    if (schema.type === 'map') namedTypesOf(schema.values, out);
  }
  return out;
}

/** 파일 하나의 기본 규칙(경로·네임스페이스·이름·열거 기본값·필드 기본값) */
export function validateFile(root, file, text) {
  const errors = [];
  let schema;
  try {
    schema = JSON.parse(text);
  } catch (e) {
    return [`${file}: JSON이 아니다: ${e.message}`];
  }
  const rel = relative(root, file).split(sep).join('/');
  const parts = rel.split('/');
  if (parts.length !== 3 || parts[0] !== 'peaket' || !parts[2].endsWith('.avsc')) {
    errors.push(`${file}: 경로는 peaket/<묶음>/<레코드>.avsc여야 한다`);
    return errors;
  }
  const bundle = parts[1];
  const name = basename(parts[2], '.avsc');
  if (!isObject(schema) || schema.type !== 'record') return [...errors, `${file}: 최상위가 record가 아니다`];
  if (schema.namespace !== `peaket.${bundle}`) errors.push(`${file}: namespace가 peaket.${bundle}이 아니다: ${String(schema.namespace)}`);
  if (schema.name !== name) errors.push(`${file}: name이 파일 이름과 다르다: ${String(schema.name)}`);
  const seen = new Set();
  for (const t of namedTypesOf(schema)) {
    if (seen.has(t.name)) errors.push(`${file}: 이름 붙은 타입 ${String(t.name)}이 한 파일 안에서 겹친다`);
    seen.add(t.name);
    if (t.type === 'enum') {
      if (!Array.isArray(t.symbols) || t.symbols.length === 0) errors.push(`${file}: 열거 ${String(t.name)}의 symbols가 비었다`);
      else {
        if (t.symbols[0] !== UNKNOWN_SYMBOL) errors.push(`${file}: 열거 ${String(t.name)}의 첫 기호가 ${UNKNOWN_SYMBOL}가 아니다`);
        if (t.default !== UNKNOWN_SYMBOL) errors.push(`${file}: 열거 ${String(t.name)}의 default가 ${UNKNOWN_SYMBOL}가 아니다`);
        if (new Set(t.symbols).size !== t.symbols.length) errors.push(`${file}: 열거 ${String(t.name)}에 같은 기호가 겹친다`);
        if (t.symbols.includes(UNKNOWN_SYMBOL) === false) errors.push(`${file}: 열거 ${String(t.name)}에 ${UNKNOWN_SYMBOL}가 없다`);
      }
    }
  }
  // 필드 이름·기본값: 유니온 기본값은 첫 갈래와 같아야 한다(Avro 1.12 명세)
  const checkFields = (record) => {
    const names = new Set();
    for (const f of record.fields ?? []) {
      if (typeof f.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.name)) errors.push(`${file}: 필드 이름이 틀렸다: ${String(f.name)}`);
      if (names.has(f.name)) errors.push(`${file}: 필드 ${f.name}가 겹친다`);
      names.add(f.name);
      if (Array.isArray(f.type) && f.default !== undefined) {
        const first = f.type[0];
        const d = f.default;
        const ok = (first === 'null' && d === null) || (typeof first === 'string' && typeof d === typeof first) || (isObject(first) && first.type === typeof d);
        if (!ok) errors.push(`${file}: 필드 ${f.name}의 기본값이 유니온 첫 갈래와 다르다`);
      }
      if (isObject(f.type) && f.type.type === 'record') checkFields(f.type);
      if (isObject(f.type) && f.type.type === 'array' && isObject(f.type.items) && f.type.items.type === 'record') checkFields(f.type.items);
    }
  };
  checkFields(schema);
  return errors;
}

export function validateTree(root) {
  const errors = [];
  const named = new Map();
  const files = listAvsc(root);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    errors.push(...validateFile(root, file, text));
    try {
      const schema = JSON.parse(text);
      for (const t of namedTypesOf(schema)) {
        const full = `${schema.namespace ?? ''}.${t.name}`;
        if (named.has(full)) errors.push(`${file}: 이름 붙은 타입 ${full}이 ${named.get(full)}와 겹친다`);
        else named.set(full, file);
      }
    } catch {
      // validateFile이 이미 오류를 냈다
    }
  }
  return errors;
}

export function listAvsc(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.avsc')) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/** 오래된 스키마(reader가 아님, writer)와 새 스키마를 BACKWARD_TRANSITIVE 뜻으로 견준다 */
export function compareSchema(oldSchema, newSchema, where = '') {
  const errors = [];
  const at = where ? `${where}: ` : '';
  if (!isObject(oldSchema) || !isObject(newSchema)) return [`${at}스키마가 record가 아니다`];
  if (oldSchema.type !== newSchema.type) errors.push(`${at}type이 바뀌었다: ${typeName(oldSchema)} → ${typeName(newSchema)}`);
  if (oldSchema.type === 'enum' && newSchema.type === 'enum') {
    const oldSymbols = oldSchema.symbols ?? [];
    const newSymbols = newSchema.symbols ?? [];
    for (const s of oldSymbols) if (!newSymbols.includes(s)) errors.push(`${at}열거 ${oldSchema.name}의 기호 ${s}가 지워졌다(또는 이름이 바뀌었다)`);
    // 옛 기호의 상대 차례를 바꾸지 않고, 새 기호는 옛 마지막 기호 뒤에만 더한다
    const kept = newSymbols.filter((s) => oldSymbols.includes(s));
    if (JSON.stringify(kept) !== JSON.stringify(oldSymbols)) errors.push(`${at}열거 ${oldSchema.name}의 옛 기호 차례가 바뀌었다`);
    const oldLast = oldSymbols[oldSymbols.length - 1];
    const lastIndex = oldLast === undefined ? -1 : newSymbols.lastIndexOf(oldLast);
    for (const [i, s] of newSymbols.entries()) {
      if (!oldSymbols.includes(s) && i <= lastIndex) errors.push(`${at}열거 ${oldSchema.name}의 새 기호 ${s}가 끝에 있지 않다`);
    }
    if (newSymbols[0] !== UNKNOWN_SYMBOL || newSchema.default !== UNKNOWN_SYMBOL) errors.push(`${at}열거 ${newSchema.name}의 첫 기호·기본값이 ${UNKNOWN_SYMBOL}가 아니다`);
    return errors;
  }
  if (oldSchema.type === 'record' && newSchema.type === 'record') {
    const oldFields = new Map((oldSchema.fields ?? []).map((f) => [f.name, f]));
    const newFields = new Map((newSchema.fields ?? []).map((f) => [f.name, f]));
    for (const [name, nf] of newFields) {
      const of = oldFields.get(name);
      if (!of) {
        // BACKWARD: 옛 데이터에 없는 새 필드는 기본값이 있어야 읽는다
        if (nf.default === undefined && !(Array.isArray(nf.type) && nf.type[0] === 'null')) errors.push(`${at}필드 ${name}가 기본값 없이 새로 더해졌다`);
        continue;
      }
      if (!sameType(of.type, nf.type)) {
        // 같은 이름의 레코드·열거는 안쪽을 따로 견준다(열거 기호 더하기는 허용)
        const named = isObject(of.type) && isObject(nf.type) && of.type.type === nf.type.type && of.type.name === nf.type.name;
        // 넓히기: 옛 T → 새 [null, T]는 옛 데이터를 읽을 수 있다. 좁히기는 안 된다
        const widened = Array.isArray(nf.type) && nf.type.some((t) => sameType(t, of.type));
        if (!named && !widened) errors.push(`${at}필드 ${name}의 형이 바뀌었다: ${typeName(of.type)} → ${typeName(nf.type)}`);
      }
    }
    // 레코드·열거 안쪽도 같은 규칙으로 본다
    for (const [name, of] of oldFields) {
      const nf = newFields.get(name);
      if (!nf || !isObject(of.type) || !isObject(nf.type)) continue;
      errors.push(...compareSchema(of.type, nf.type, `${where}${where ? '.' : ''}${name}`));
    }
  }
  return errors;
}

/** 지난 출시 태그의 avsc와 지금 avsc를 견준다. base가 없으면 지금 파일의 기본 규칙만 본다 */
export function compareWithBase(root, ref) {
  const errors = validateTree(root);
  // git은 저장소 기준 상대 경로만 받는다. root가 절대 경로(기본값)여도 동작하게 바꾼다
  const gitRoot = relative(process.cwd(), root).split(sep).join('/');
  let oldFiles;
  try {
    oldFiles = execFileSync('git', ['ls-tree', '-r', '--name-only', ref, '--', gitRoot], { encoding: 'utf8', cwd: process.cwd() })
      .split(/\r?\n/)
      .filter((p) => p.endsWith('.avsc'));
  } catch (e) {
    return [...errors, `기준 ${ref}의 스키마를 읽지 못했다: ${e.message}`];
  }
  const current = new Map(listAvsc(root).map((f) => [relative(root, f).split(sep).join('/'), f]));
  for (const rel of oldFiles) {
    const relInRoot = rel.startsWith(`${gitRoot}/`) ? rel.slice(gitRoot.length + 1) : rel;
    const cur = current.get(relInRoot);
    if (!cur) {
      errors.push(`${relInRoot}: 기준 ${ref}에 있던 스키마가 지금 없다`);
      continue;
    }
    let oldSchema;
    try {
      oldSchema = JSON.parse(execFileSync('git', ['show', `${ref}:${rel}`], { encoding: 'utf8', cwd: process.cwd() }));
    } catch (e) {
      errors.push(`${relInRoot}: 기준 ${ref}의 스키마를 읽지 못했다: ${e.message}`);
      continue;
    }
    errors.push(...compareSchema(oldSchema, JSON.parse(readFileSync(cur, 'utf8')), relInRoot));
  }
  return errors;
}

/** 레지스트리 등록(선택). 주제 이름은 topic-map의 파일 이름 → 주제로 찾는다. CI는 로컬 컨테이너만 쓴다 */
export async function registerToRegistry(root, registry, topicMap) {
  const errors = [];
  const ids = {};
  for (const file of listAvsc(root)) {
    const rel = relative(root, file).split(sep).join('/');
    const topic = topicMap[rel];
    if (!topic) {
      errors.push(`${rel}: topic-map에 주제가 없다`);
      continue;
    }
    const schema = JSON.parse(readFileSync(file, 'utf8'));
    const subject = `${topic}-${schema.namespace}.${schema.name}`;
    const res = await fetch(`${registry.replace(/\/$/, '')}/subjects/${encodeURIComponent(subject)}/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/vnd.schemaregistry.v1+json' },
      body: JSON.stringify({ schema: JSON.stringify(schema) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      errors.push(`${subject}: 등록이 실패했다(${res.status}): ${(await res.text()).slice(0, 200)}`);
      continue;
    }
    const body = await res.json();
    if (!Number.isInteger(body?.id)) errors.push(`${subject}: 응답에 스키마 ID가 없다`);
    else ids[topic] = body.id;
  }
  return { errors, ids };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const rootAt = args.indexOf('--root');
  const baseAt = args.indexOf('--base');
  const registryAt = args.indexOf('--registry');
  const topicAt = args.indexOf('--topic-map');
  const root = rootAt >= 0 ? args[rootAt + 1] : DEFAULT_ROOT;
  const base = baseAt >= 0 ? args[baseAt + 1] : undefined;
  const registry = registryAt >= 0 ? args[registryAt + 1] : undefined;
  const topicMap = topicAt >= 0 ? JSON.parse(readFileSync(args[topicAt + 1], 'utf8')) : {};
  const errors = base ? compareWithBase(root, base) : validateTree(root);
  if (registry) {
    const r = await registerToRegistry(root, registry, topicMap);
    errors.push(...r.errors);
    if (Object.keys(r.ids).length > 0) console.log(JSON.stringify(r.ids, null, 2));
  }
  for (const e of errors) console.log(`실패: ${e}`);
  console.log(errors.length ? `Avro 스키마 검사 실패: ${errors.length}건` : `Avro 스키마 검사 통과: ${listAvsc(root).length}개 파일`);
  process.exitCode = errors.length ? 1 : 0;
}
