#!/usr/bin/env node
// v1 릴리스 범위 검사(ADR-0386, REL-010).
//
// --check
//   - docs/release/v1-scope.json(manifest)의 기능 ID와 docs/BUILD_ORDER.md '기능 단위 계획' 표의
//     기능 ID가 정확히 한 번씩 같은지 본다.
//   - docs/release/v1-scope.md의 분류 표가 manifest와 같은 분류·BUILD_ORDER 상태를 적었는지 본다.
//   - gates 배열은 분류가 gate인 기능과, frozen 배열은 frozen-local인 기능과 정확히 같은지 본다.
//   - manifest에 없는 ID, 표에 없는 ID, 두 번 나온 ID, 분류와 BUILD_ORDER 상태가 어긋난 줄을 막는다.
//
// --release
//   --check를 먼저 하고, 릴리스 가지에서만 도는 검사를 더한다.
//   - 현재 가지가 release/* 또는 main인지 본다(--branch로 바꿀 수 있다).
//   - deploy/envs/<환경>/flags/의 릴리스 플래그 파일에 동결 기능 ID가 적혀 있으면 막는다.
//   - services/*/migrations/*.sql 주석에 동결 기능 ID가 적혀 있으면 막는다.
//
//   한계(자동화할 수 없는 것):
//   - 마이그레이션 SQL은 기능 ID를 주석으로 달지 않는다. 그래서 파일 이름·주석만 보고는 동결 기능의
//     표·칸 변경을 가려낼 수 없다. 릴리스 전에 `git diff <릴리스 기준>..release/1.0.0 --
//     services/*/migrations`를 사람이 동결 기능 계획과 대조해야 한다.
//   - 릴리스 플래그 배포 기구(F-09-2)가 동결이라 지금은 deploy/envs/<환경>/flags/가 없다. 플래그가
//     생기면 이 검사가 플래그 파일의 기능 ID를 보지만, 플래그 이름만 바꾼 동결 몫은 여전히 사람이 본다.
//   - 릴리스 태그·main의 deploy/를 Argo CD가 읽는지, 게이트 측정이 끝났는지는 git 파일만으로 알 수
//     없다. 이 도구는 선언된 범위의 정합성만 본다.
//
// 쓰는 법: node tools/ci/release-scope.mjs [--check|--release] [--root <폴더>] [--branch <가지>]
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const CLASSES = new Set(['release', 'gate', 'frozen-local']);
const STATUSES = new Set(['대기', '진행', '완료', '일부 완료', '일부 구현 있음', '막힘', '동결']);
const RELEASE_STATUSES = new Set(['진행', '완료', '일부 완료', '일부 구현 있음']);
const GATE_STATUSES = new Set(['대기', '진행', '일부 완료', '일부 구현 있음']);
const TABLE_HEADER = ['ID', '영역', '기능', 'BUILD_ORDER 상태', '분류', '출시 근거·게이트', '배포 단위', '플래그', '마이그레이션', '남은 일'];

const { values } = parseArgs({
  options: {
    check: { type: 'boolean', default: false },
    release: { type: 'boolean', default: false },
    root: { type: 'string', default: '.' },
    branch: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log('사용법: node tools/ci/release-scope.mjs [--check|--release] [--root <폴더>] [--branch <가지>]');
  process.exit(0);
}

const root = values.root;
const errors = [];
const skips = [];

function read(rel) {
  try {
    return readFileSync(join(root, rel), 'utf8');
  } catch (e) {
    errors.push(`막음: ${rel}: 읽을 수 없다(${e.code || e.message})`);
    return null;
  }
}

function splitRow(line) {
  return line
    .replace(/\\\|/g, '\u0000')
    .split('|')
    .slice(1, -1)
    .map((s) => s.replace(/\u0000/g, '|').trim());
}

function parseBuildOrder(text) {
  const rows = [];
  const seen = new Map();
  text.split(/\r?\n/).forEach((line, i) => {
    if (!/^\| F-\d{2}-\d+ \|/.test(line)) return;
    const c = splitRow(line);
    const id = c[0];
    if (!/^F-\d{2}-\d+$/.test(id)) return;
    if (seen.has(id)) {
      errors.push(`막음: docs/BUILD_ORDER.md:${i + 1}: 기능 ${id}가 ${seen.get(id)}줄에도 있다`);
      return;
    }
    seen.set(id, i + 1);
    rows.push({ id, area: c[1], status: c[8], line: i + 1 });
  });
  return rows;
}

function parseScopeTable(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `| ${TABLE_HEADER.join(' | ')} |`);
  if (start < 0) {
    errors.push('막음: docs/release/v1-scope.md: 기능 분류 표 머리를 찾지 못했다');
    return [];
  }
  const rows = [];
  const seen = new Map();
  for (let i = start + 2; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith('|')) break;
    if (!/^\| F-\d{2}-\d+ \|/.test(line)) continue;
    const c = splitRow(line);
    if (c.length !== TABLE_HEADER.length) {
      errors.push(`막음: docs/release/v1-scope.md:${i + 1}: 칸이 ${c.length}개다(10개여야 한다)`);
      continue;
    }
    const id = c[0];
    if (seen.has(id)) {
      errors.push(`막음: docs/release/v1-scope.md:${i + 1}: 기능 ${id}가 ${seen.get(id)}줄에도 있다`);
      continue;
    }
    seen.set(id, i + 1);
    rows.push({
      id,
      area: c[1],
      name: c[2],
      status: c[3],
      cls: c[4],
      reason: c[5],
      deploy: c[6],
      flag: c[7],
      migration: c[8],
      left: c[9],
      line: i + 1,
    });
  }
  return rows;
}

function parseManifest(text) {
  if (text == null) return null;
  const featureKey = /"(F-\d{2}-\d+)"\s*:/g;
  const keys = [...text.matchAll(featureKey)].map((m) => m[1]);
  const counts = new Map();
  for (const id of keys) counts.set(id, (counts.get(id) || 0) + 1);
  for (const [id, n] of counts) {
    if (n > 1) errors.push(`막음: docs/release/v1-scope.json: 기능 ${id}가 ${n}번 나온다(중복 키)`);
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (e) {
    errors.push(`막음: docs/release/v1-scope.json: JSON을 읽지 못했다(${e.message})`);
    return null;
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    errors.push('막음: docs/release/v1-scope.json: 최상위가 객체가 아니다');
    return null;
  }
  if (manifest.version !== 'v1') errors.push(`막음: docs/release/v1-scope.json: version이 v1이 아니다(${JSON.stringify(manifest.version)})`);
  const features = manifest.features;
  if (features === null || typeof features !== 'object' || Array.isArray(features)) {
    errors.push('막음: docs/release/v1-scope.json: features 객체가 없다');
    return null;
  }
  const ids = new Set();
  for (const [id, value] of Object.entries(features)) {
    if (!/^F-\d{2}-\d+$/.test(id)) {
      errors.push(`막음: docs/release/v1-scope.json: 기능 ID 꼴이 아니다(${id})`);
      continue;
    }
    if (ids.has(id)) {
      errors.push(`막음: docs/release/v1-scope.json: 기능 ${id}가 두 번 있다`);
      continue;
    }
    ids.add(id);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`막음: docs/release/v1-scope.json: ${id}의 값이 객체가 아니다`);
      continue;
    }
    if (!CLASSES.has(value.class)) {
      errors.push(`막음: docs/release/v1-scope.json: ${id}의 class가 '${value.class}'다(release|gate|frozen-local)`);
    }
    if (typeof value.reason !== 'string' || value.reason.trim() === '') {
      errors.push(`막음: docs/release/v1-scope.json: ${id}의 reason이 비었다`);
    }
  }
  for (const key of ['gates', 'frozen']) {
    if (!Array.isArray(manifest[key])) {
      errors.push(`막음: docs/release/v1-scope.json: ${key} 배열이 없다`);
      continue;
    }
    const seen = new Set();
    for (const id of manifest[key]) {
      if (typeof id !== 'string' || !/^F-\d{2}-\d+$/.test(id)) {
        errors.push(`막음: docs/release/v1-scope.json: ${key}에 기능 ID가 아닌 값(${JSON.stringify(id)})`);
        continue;
      }
      if (seen.has(id)) errors.push(`막음: docs/release/v1-scope.json: ${key}에 ${id}가 두 번 있다`);
      seen.add(id);
      if (!ids.has(id)) errors.push(`막음: docs/release/v1-scope.json: ${key}의 ${id}가 features에 없다`);
    }
  }
  return manifest;
}

function checkSets(label, actual, expected) {
  const missing = [...expected].filter((x) => !actual.has(x));
  const extra = [...actual].filter((x) => !expected.has(x));
  for (const id of missing.sort()) errors.push(`막음: ${label}: ${id}가 빠졌다`);
  for (const id of extra.sort()) errors.push(`막음: ${label}: ${id}가 분류와 다르게 들어 있다`);
}

function checkStatus(id, cls, status, source) {
  if (!STATUSES.has(status)) {
    errors.push(`막음: ${source}: ${id}의 BUILD_ORDER 상태 '${status}'를 모른다`);
    return;
  }
  if (cls === 'release' && !RELEASE_STATUSES.has(status)) {
    errors.push(`막음: ${source}: ${id}는 release인데 BUILD_ORDER 상태 '${status}'는 쓸 수 없다`);
  }
  if (cls === 'gate' && !GATE_STATUSES.has(status)) {
    errors.push(`막음: ${source}: ${id}는 gate인데 BUILD_ORDER 상태 '${status}'는 쓸 수 없다`);
  }
  if (cls === 'frozen-local' && status === '완료') {
    errors.push(`막음: ${source}: ${id}는 frozen-local인데 BUILD_ORDER 상태 '완료'는 쓸 수 없다`);
  }
}

const buildText = read('docs/BUILD_ORDER.md');
const tableText = read('docs/release/v1-scope.md');
const manifestText = read('docs/release/v1-scope.json');
if (buildText == null || tableText == null || manifestText == null) {
  errors.push('막음: 검사에 필요한 파일이 없다');
}

let build = [];
let table = [];
let manifest = null;
if (buildText != null) build = parseBuildOrder(buildText);
if (tableText != null) table = parseScopeTable(tableText);
if (manifestText != null) manifest = parseManifest(manifestText);

if (build.length !== 105) errors.push(`막음: docs/BUILD_ORDER.md: 기능이 ${build.length}개다(105개여야 한다)`);
if (table.length !== 105) errors.push(`막음: docs/release/v1-scope.md: 분류 표 줄이 ${table.length}개다(105개여야 한다)`);

const buildById = new Map(build.map((r) => [r.id, r]));
const tableById = new Map(table.map((r) => [r.id, r]));

if (manifest != null) {
  const featureIds = new Set(Object.keys(manifest.features));
  checkSets('docs/release/v1-scope.json 대 docs/BUILD_ORDER.md', featureIds, new Set(buildById.keys()));
  checkSets('docs/release/v1-scope.md 대 docs/BUILD_ORDER.md', new Set(tableById.keys()), new Set(buildById.keys()));

  const gateSet = new Set(manifest.gates || []);
  const frozenSet = new Set(manifest.frozen || []);
  const classGate = new Set(Object.entries(manifest.features).filter(([, v]) => v.class === 'gate').map(([id]) => id));
  const classFrozen = new Set(Object.entries(manifest.features).filter(([, v]) => v.class === 'frozen-local').map(([id]) => id));
  checkSets('docs/release/v1-scope.json gates', gateSet, classGate);
  checkSets('docs/release/v1-scope.json frozen', frozenSet, classFrozen);
  for (const id of gateSet) if (frozenSet.has(id)) errors.push(`막음: docs/release/v1-scope.json: ${id}가 gates와 frozen에 모두 있다`);
  const union = new Set([...gateSet, ...frozenSet]);
  for (const id of union) if (!featureIds.has(id)) errors.push(`막음: docs/release/v1-scope.json: ${id}가 features에 없다`);

  for (const [id, value] of Object.entries(manifest.features)) {
    const row = buildById.get(id);
    if (row) checkStatus(id, value.class, row.status, 'docs/BUILD_ORDER.md');
    const t = tableById.get(id);
    if (!t) continue;
    if (t.cls !== value.class) errors.push(`막음: docs/release/v1-scope.md:${t.line}: ${id}의 분류 '${t.cls}'가 manifest '${value.class}'와 다르다`);
    if (t.reason !== value.reason) errors.push(`막음: docs/release/v1-scope.md:${t.line}: ${id}의 출시 근거·게이트 칸이 manifest와 다르다`);
    for (const key of ['reason', 'deploy', 'flag', 'migration', 'left']) {
      if (t[key] === '') errors.push(`막음: docs/release/v1-scope.md:${t.line}: ${id}의 '${key}' 칸이 비었다`);
    }
    if (row) {
      if (t.status !== row.status) errors.push(`막음: docs/release/v1-scope.md:${t.line}: ${id}의 BUILD_ORDER 상태 '${t.status}'가 실제 '${row.status}'와 다르다`);
      if (t.area !== row.area) errors.push(`막음: docs/release/v1-scope.md:${t.line}: ${id}의 영역 '${t.area}'가 실제 '${row.area}'와 다르다`);
    }
  }
}

function countClasses() {
  const c = { release: 0, gate: 0, 'frozen-local': 0 };
  if (manifest) for (const v of Object.values(manifest.features)) if (c[v.class] != null) c[v.class] += 1;
  return c;
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function releaseChecks() {
  const branch = values.branch || (() => {
    const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) {
      errors.push('막음: --release: 현재 가지를 읽지 못했다(git rev-parse)');
      return '';
    }
    return r.stdout.trim();
  })();
  if (branch && !/^release\//.test(branch) && branch !== 'main') {
    errors.push(`막음: --release: 가지 '${branch}'는 release/* 또는 main이 아니다`);
  }

  const frozenIds = new Set((manifest && manifest.frozen) || []);
  if (frozenIds.size === 0) {
    skips.push('--release: manifest frozen 목록이 비어 동결 ID 검사를 건너뛴다');
    return;
  }

  const flagFiles = walk(join(root, 'deploy')).filter((p) => /[\\/]flags[\\/]/.test(p));
  if (flagFiles.length === 0) {
    skips.push('--release: deploy/envs/*/flags/가 없다(F-09-2 릴리스 플래그 동결). 검사할 플래그 0개');
  }
  // 플래그 파일만 본다. deploy/의 다른 값·주석은 기능 ID를 근거로 적을 수 있어
  // 동결 몫이 섞였다는 뜻이 아니다(예: 관측 규칙 주석의 F-01-10).
  let deployHits = 0;
  for (const p of flagFiles) {
    let text;
    try {
      text = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    for (const id of frozenIds) {
      if (text.includes(id)) {
        deployHits += 1;
        errors.push(`막음: ${relative(root, p).split(sep).join('/')}: 동결 기능 ${id}가 릴리스 플래그에 있다`);
      }
    }
  }

  const migrationFiles = walk(join(root, 'services')).filter((p) => /[\\/]migrations[\\/].*\.sql$/.test(p));
  let migrationHits = 0;
  for (const p of migrationFiles) {
    let text;
    try {
      text = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    for (const id of frozenIds) {
      if (text.includes(id)) {
        migrationHits += 1;
        errors.push(`막음: ${relative(root, p).split(sep).join('/')}: 동결 기능 ${id}가 마이그레이션에 있다`);
      }
    }
  }
  console.log(`--release: deploy 플래그 파일 ${flagFiles.length}개, 마이그레이션 ${migrationFiles.length}개를 봤다(동결 ID 적중 ${deployHits + migrationHits}건)`);
  console.log('--release 한계: 마이그레이션은 기능 ID 주석이 없으면 동결 몫을 가려내지 못한다. 릴리스 전에 migrations diff를 사람이 동결 기능 계획과 대조한다.');
}

if (errors.length === 0 && values.release) releaseChecks();

if (errors.length > 0) {
  for (const e of errors) console.error(e);
  console.error(`v1 릴리스 범위 검사 실패: ${errors.length}건`);
  process.exit(1);
}
for (const s of skips) console.log(s);
const c = countClasses();
console.log(`v1 릴리스 범위 검사 통과: 기능 ${build.length}개(release ${c.release}, gate ${c.gate}, frozen-local ${c['frozen-local']}), gates ${manifest.gates.length}개, frozen ${manifest.frozen.length}개`);
