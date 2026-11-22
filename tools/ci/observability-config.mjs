#!/usr/bin/env node
// 관측 설정 정적 검사(ADR-0356 결정 2·3, V-T47 ④⑤, ASVS v5.0.0-16.4.2, OPS-040). 클러스터 없이 저장소 파일끼리 맞는지 본다.
// - Grafana 조직·팀·폴더(deploy/platform/observability/grafana/access.yaml): 조직 둘(기본·제한), 팀이 teams.json의 가상 팀과 같은지
// - 데이터 소스(provisioning/datasources*.yaml): 항목마다 orgId가 있고, PostgreSQL(쿼리 문장) 데이터 소스는 제한 조직에만 있는지,
//   제한 조직 밖의 데이터 소스가 그 uid를 가리키지 않는지
// - 대시보드 공급자(provisioning/dashboards.yaml): access.yaml 폴더마다 공급자 하나(조직·제목·uid 같음), 화면 고침 저장 안 함,
//   경로 /var/lib/grafana/dashboards/<폴더 uid> = 저장소 deploy/local/dashboards/<폴더 uid>/(대시보드가 있어야 함), 공급자 없는 대시보드 폴더 없음
// - 대시보드: 제한 조직 밖 폴더의 대시보드가 PostgreSQL 데이터 소스 uid를 가리키지 않는지(제한 조직 대시보드가 다른 uid를 쓰는 것은 막지 않는다)
// - 보존(deploy/platform/observability/mimir/runtime-overrides.yaml): 테넌트 raw·agg5m의 보존이 docs/observability.md §9 보존 표
//   '시계열 메트릭' 행의 값과 같은지(개월은 31일 달로 센다)
// - 원격 쓰기(deploy/platform/observability/prometheus/remote-write.yaml): 테넌트 raw·agg5m 하나씩, raw는 거르지 않고, agg5m은 이름 앞머리
//   agg5m:만 남기는 거름 하나
// - 기록 규칙(deploy/platform/observability/ 아래 규칙 묶음): 이름이 agg5m:으로 시작하는 규칙은 모두 평가 간격 5분 묶음 안에 있는지
// 쓰는 법: node tools/ci/observability-config.mjs --check [--root <저장소>]
//   끝 코드 0 통과, 1 위반(모두 '막음: <파일>: <까닭>'으로 찍는다), 2 인자 오류·파일 읽기 오류
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';
import { ACCESS_FILE, loadGrafanaAccess } from '../local/grafana-access.mjs';

const USAGE = '쓰는 법: node tools/ci/observability-config.mjs --check [--root <저장소>]';
const OBS = 'deploy/platform/observability';
const PROVISIONING = `${OBS}/grafana/provisioning`;
const DATASOURCE_FILES = [`${PROVISIONING}/datasources.yaml`, `${PROVISIONING}/datasources-platform.yaml`];
const DASHBOARD_PROVIDERS = `${PROVISIONING}/dashboards.yaml`;
const MIMIR_OVERRIDES = `${OBS}/mimir/runtime-overrides.yaml`;
const REMOTE_WRITE = `${OBS}/prometheus/remote-write.yaml`;
const DASHBOARDS_DIR = 'deploy/local/dashboards';
const PROVIDER_ROOT = '/var/lib/grafana/dashboards';
const RETENTION_DOC = 'docs/observability.md';
const PG_TYPES = new Set(['postgres', 'grafana-postgresql-datasource']);
const TENANTS = ['raw', 'agg5m'];
const AGG_PREFIX = 'agg5m:';
/** 1개월을 몇 일로 세는가(보존이 모자라지 않게 긴 달로 센다, runtime-overrides.yaml 머리말) */
const DAYS_PER_MONTH = 31;

/** 읽기 실패(끝 코드 2) */
class ReadError extends Error {}

const readText = (root, rel) => {
  const file = join(root, rel);
  if (!existsSync(file)) throw new ReadError(`${rel}이 없다`);
  return readFileSync(file, 'utf8');
};

/** YAML 문서 전부(빈 문서는 뺀다). 해석 오류는 읽기 실패 */
const readYaml = (root, rel) => {
  const docs = parseAllDocuments(readText(root, rel));
  for (const d of docs) if (d.errors.length) throw new ReadError(`${rel}: YAML을 읽지 못했다: ${d.errors[0].message}`);
  return docs.map((d) => d.toJS()).filter((x) => x !== null && x !== undefined);
};

/** 값 안의 모든 문자열(깊이 끝까지) */
function* strings(value) {
  if (typeof value === 'string') yield value;
  else if (Array.isArray(value)) for (const v of value) yield* strings(v);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) yield* strings(v);
}

/** 대시보드가 가리키는 데이터 소스 uid: { datasource: { uid } }와 { datasource: '<uid>' } 꼴 모두 */
function datasourceUids(value, out = new Set()) {
  if (Array.isArray(value)) for (const v of value) datasourceUids(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'datasource') {
        if (typeof v === 'string') out.add(v);
        else if (v && typeof v === 'object' && typeof v.uid === 'string') out.add(v.uid);
      }
      if (k === 'datasourceUid' && typeof v === 'string') out.add(v);
      datasourceUids(v, out);
    }
  }
  return out;
}

/** '90d'·'403d'·'2160h'·'1y'·'2w' 꼴 기간을 일로(정수 일이 아니면 소수) */
export function durationDays(text) {
  const m = /^(\d+)(y|w|d|h)$/.exec(String(text ?? '').trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return { y: 365, w: 7, d: 1, h: 1 / 24 }[m[2]] * n;
}

/** docs/observability.md §9 보존 표의 '시계열 메트릭' 행에서 원본(일)·5분 집계(개월)를 읽어 테넌트별 일 수로 */
export function retentionFromDoc(root) {
  const line = readText(root, RETENTION_DOC).split(/\r?\n/).find((l) => /^\|\s*시계열 메트릭\s*\|/.test(l));
  if (!line) throw new ReadError(`${RETENTION_DOC}: 보존 표의 '시계열 메트릭' 행이 없다`);
  const raw = /원본\s*(\d+)\s*일/.exec(line)?.[1];
  const agg = /5분 집계\s*(\d+)\s*개월/.exec(line)?.[1];
  if (!raw || !agg) throw new ReadError(`${RETENTION_DOC}: '시계열 메트릭' 행에서 '원본 N일'·'5분 집계 N개월'을 읽지 못했다`);
  return { raw: Number(raw), agg5m: Number(agg) * DAYS_PER_MONTH };
}

/** 저장소 deploy/local/dashboards/ 아래 폴더별 대시보드 파일 */
function dashboardDirs(root) {
  const dir = join(root, DASHBOARDS_DIR);
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.set(e.name, readdirSync(join(dir, e.name)).filter((f) => f.endsWith('.json')).sort());
    else if (e.name.endsWith('.json')) out.set('', [...(out.get('') ?? []), e.name]);
  }
  return out;
}

/** 규칙 묶음이 든 파일(deploy/platform/observability/ 아래 .yaml·.yml) */
function* ruleFiles(root) {
  const walk = function* (d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) yield* walk(p);
      else if (/\.ya?ml$/.test(e.name)) yield relative(root, p).split('\\').join('/');
    }
  };
  const base = join(root, OBS);
  if (existsSync(base)) yield* walk(base);
}

/** 위반 목록(빈 배열이면 통과). 각 항목은 '<파일>: <까닭>'. 읽기 실패는 ReadError로 던진다 */
export function checkObservabilityConfig(root) {
  const problems = [];
  const bad = (file, why) => problems.push(`${file}: ${why}`);

  // --- Grafana 조직·팀·폴더 ---
  let access;
  try {
    access = loadGrafanaAccess(root);
  } catch (e) {
    throw new ReadError(e.message);
  }
  const restricted = access.orgs.filter((o) => o.restricted);
  const open = access.orgs.filter((o) => !o.restricted);
  if (restricted.length !== 1 || open.length !== 1) bad(ACCESS_FILE, `조직은 기본 하나·제한 하나여야 한다(지금 기본 ${open.length}·제한 ${restricted.length}, observability §9)`);
  if (open[0] && open[0].id !== 1) bad(ACCESS_FILE, `기본 조직의 id는 1이어야 한다(Grafana 1번 조직, 지금 ${open[0].id})`);
  const restrictedIds = new Set(restricted.map((o) => o.id));
  const orgIds = new Set(access.orgs.map((o) => o.id));
  const teamsJson = JSON.parse(readText(root, 'infra/stacks/global/github/teams.json')).teams.map((t) => t.slug).sort();
  const teamSlugs = access.teams.map((t) => t.slug).sort();
  if (JSON.stringify(teamsJson) !== JSON.stringify(teamSlugs)) bad(ACCESS_FILE, `팀이 가상 팀 목록(infra/stacks/global/github/teams.json)과 다르다: ${teamSlugs.join(',')} ↔ ${teamsJson.join(',')}`);
  const folderUids = access.folders.map((f) => f.uid);
  for (const uid of new Set(folderUids)) if (folderUids.filter((x) => x === uid).length > 1) bad(ACCESS_FILE, `폴더 uid ${uid}가 둘 이상이다`);

  // --- 데이터 소스 ---
  const datasources = [];
  for (const rel of DATASOURCE_FILES) {
    for (const doc of readYaml(root, rel)) {
      for (const ds of doc.datasources ?? []) {
        if (!Number.isInteger(ds.orgId)) bad(rel, `데이터 소스 ${ds.name ?? ds.uid}에 orgId가 없다(조직을 적지 않으면 기본 조직에 실린다)`);
        else if (!orgIds.has(ds.orgId)) bad(rel, `데이터 소스 ${ds.name ?? ds.uid}의 orgId ${ds.orgId}가 ${ACCESS_FILE}에 없다`);
        if (typeof ds.uid !== 'string' || !ds.uid) bad(rel, `데이터 소스 ${ds.name}에 uid가 없다`);
        datasources.push({ ...ds, file: rel });
      }
    }
  }
  if (datasources.length === 0) bad(DATASOURCE_FILES[0], '데이터 소스가 하나도 없다');
  const pg = datasources.filter((ds) => PG_TYPES.has(ds.type));
  if (pg.length === 0) bad(DATASOURCE_FILES[0], 'PostgreSQL 쿼리 문장 데이터 소스가 없다(제한 조직, observability §9)');
  for (const ds of pg) {
    if (!restrictedIds.has(ds.orgId)) bad(ds.file, `PostgreSQL 데이터 소스 ${ds.uid}가 제한 조직 밖(orgId ${ds.orgId})에 있다(observability §9: 제한 조직에만)`);
  }
  const pgUids = new Set(pg.map((ds) => ds.uid));
  for (const ds of datasources) {
    if (restrictedIds.has(ds.orgId) || PG_TYPES.has(ds.type)) continue;
    for (const s of strings({ jsonData: ds.jsonData, secureJsonData: ds.secureJsonData })) {
      if (pgUids.has(s)) bad(ds.file, `제한 조직 밖 데이터 소스 ${ds.uid}가 PostgreSQL 데이터 소스 ${s}를 가리킨다`);
    }
  }

  // --- 대시보드 공급자와 대시보드 ---
  const providers = readYaml(root, DASHBOARD_PROVIDERS).flatMap((d) => d.providers ?? []);
  if (providers.length === 0) bad(DASHBOARD_PROVIDERS, '공급자가 하나도 없다');
  const dirs = dashboardDirs(root);
  if (dirs.has('')) bad(DASHBOARDS_DIR, `폴더 밖 대시보드가 있다(공급자가 싣지 않는다): ${dirs.get('').join(', ')}`);
  const seenProviderDirs = new Set();
  for (const p of providers) {
    const name = p.name ?? '(이름 없음)';
    if (p.allowUiUpdates !== false) bad(DASHBOARD_PROVIDERS, `공급자 ${name}: allowUiUpdates가 false가 아니다(화면에서 고친 것을 저장하지 않는다, observability §9)`);
    if (p.type !== 'file') bad(DASHBOARD_PROVIDERS, `공급자 ${name}: type이 file이 아니다`);
    if (!Number.isInteger(p.orgId)) bad(DASHBOARD_PROVIDERS, `공급자 ${name}에 orgId가 없다`);
    const folder = access.folders.find((f) => f.uid === p.folderUid);
    if (!folder) bad(DASHBOARD_PROVIDERS, `공급자 ${name}의 폴더 uid ${p.folderUid}가 ${ACCESS_FILE} folders에 없다`);
    else {
      if (folder.org !== p.orgId) bad(DASHBOARD_PROVIDERS, `공급자 ${name}의 orgId ${p.orgId}가 폴더 ${folder.uid}의 조직 ${folder.org}과 다르다`);
      if (folder.title !== p.folder) bad(DASHBOARD_PROVIDERS, `공급자 ${name}의 폴더 제목 '${p.folder}'이 ${ACCESS_FILE}의 '${folder.title}'과 다르다`);
    }
    const path = p.options?.path;
    const sub = typeof path === 'string' && path.startsWith(`${PROVIDER_ROOT}/`) ? path.slice(PROVIDER_ROOT.length + 1) : undefined;
    if (sub === undefined || sub !== p.folderUid) {
      bad(DASHBOARD_PROVIDERS, `공급자 ${name}의 경로가 ${PROVIDER_ROOT}/<폴더 uid>가 아니다: ${path}`);
      continue;
    }
    if (seenProviderDirs.has(sub)) bad(DASHBOARD_PROVIDERS, `폴더 ${sub}을 싣는 공급자가 둘 이상이다`);
    seenProviderDirs.add(sub);
    const files = dirs.get(sub) ?? [];
    if (files.length === 0) bad(DASHBOARD_PROVIDERS, `공급자 ${name}의 폴더 ${DASHBOARDS_DIR}/${sub}/에 대시보드가 없다`);
    // 제한 조직 밖 대시보드가 PostgreSQL uid를 가리키면 기본 조직 사용자가 쿼리 문장을 본다(V-T47 ④)
    if (!restrictedIds.has(p.orgId)) {
      for (const f of files) {
        const rel = `${DASHBOARDS_DIR}/${sub}/${f}`;
        let json;
        try {
          json = JSON.parse(readText(root, rel));
        } catch (e) {
          if (e instanceof ReadError) throw e;
          throw new ReadError(`${rel}: JSON을 읽지 못했다: ${e.message}`);
        }
        for (const uid of datasourceUids(json)) if (pgUids.has(uid)) bad(rel, `제한 조직 밖(orgId ${p.orgId}) 대시보드가 PostgreSQL 데이터 소스 ${uid}를 가리킨다`);
      }
    }
  }
  for (const f of access.folders) if (!providers.some((p) => p.folderUid === f.uid)) bad(ACCESS_FILE, `폴더 ${f.uid}를 싣는 공급자가 ${DASHBOARD_PROVIDERS}에 없다`);
  for (const sub of dirs.keys()) if (sub && !seenProviderDirs.has(sub)) bad(`${DASHBOARDS_DIR}/${sub}`, '이 폴더를 싣는 공급자가 없다');

  // --- 보존 ---
  const want = retentionFromDoc(root);
  const overrides = readYaml(root, MIMIR_OVERRIDES)[0]?.overrides ?? {};
  for (const t of TENANTS) {
    const got = durationDays(overrides[t]?.compactor_blocks_retention_period);
    if (got === undefined) bad(MIMIR_OVERRIDES, `테넌트 ${t}의 compactor_blocks_retention_period가 없거나 기간 꼴(<수>y|w|d|h)이 아니다`);
    else if (got !== want[t]) bad(MIMIR_OVERRIDES, `테넌트 ${t}의 보존 ${got}일이 ${RETENTION_DOC} 보존 표의 ${want[t]}일과 다르다`);
  }
  for (const t of Object.keys(overrides)) if (!TENANTS.includes(t)) bad(MIMIR_OVERRIDES, `모르는 테넌트 ${t}(raw·agg5m만)`);

  // --- 원격 쓰기 ---
  const rw = readYaml(root, REMOTE_WRITE)[0]?.remote_write ?? [];
  for (const t of TENANTS) {
    const ends = rw.filter((r) => r?.headers?.['X-Scope-OrgID'] === t);
    if (ends.length !== 1) {
      bad(REMOTE_WRITE, `테넌트 ${t}로 보내는 원격 쓰기가 하나가 아니다(${ends.length}개)`);
      continue;
    }
    const relabel = ends[0].write_relabel_configs ?? [];
    if (t === 'raw' && relabel.length > 0) bad(REMOTE_WRITE, '원본(raw) 원격 쓰기는 거르지 않는다(모두 보낸다)');
    if (t === 'agg5m') {
      const ok =
        relabel.length === 1 &&
        relabel[0].action === 'keep' &&
        JSON.stringify(relabel[0].source_labels) === JSON.stringify(['__name__']) &&
        typeof relabel[0].regex === 'string' &&
        /^agg5m:(?:\.\+|\.\*)$/.test(relabel[0].regex);
      if (!ok) bad(REMOTE_WRITE, `agg5m 원격 쓰기는 이름 앞머리 ${AGG_PREFIX}만 남기는 거름 하나여야 한다(source_labels [__name__], regex ${AGG_PREFIX}.+, action keep): ${JSON.stringify(relabel)}`);
    }
  }
  for (const r of rw) if (!TENANTS.includes(r?.headers?.['X-Scope-OrgID'])) bad(REMOTE_WRITE, `모르는 테넌트로 보내는 원격 쓰기: ${r?.name ?? r?.url}`);

  // --- 5분 집계 기록 규칙 ---
  let aggRules = 0;
  for (const rel of ruleFiles(root)) {
    for (const doc of readYaml(root, rel)) {
      const groups = doc?.spec?.groups ?? doc?.groups;
      if (!Array.isArray(groups)) continue;
      for (const g of groups) {
        for (const r of g?.rules ?? []) {
          if (typeof r?.record !== 'string' || !r.record.startsWith(AGG_PREFIX)) continue;
          aggRules++;
          if (g.interval !== '5m') bad(rel, `기록 규칙 ${r.record}가 평가 간격 5분이 아닌 묶음 ${g.name}(${g.interval ?? '기본 간격'})에 있다(${AGG_PREFIX} 규칙은 5분 묶음에만)`);
        }
      }
    }
  }
  if (aggRules === 0) bad(`${OBS}/rules`, `${AGG_PREFIX} 기록 규칙이 하나도 없다(agg5m 테넌트로 보낼 것이 없다)`);
  return problems;
}

/** @param {string[]} argv @returns {number} */
export function main(argv) {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') check = true;
    else if (a === '--root' && argv[i + 1]) root = resolve(argv[++i]);
    else {
      console.error(`observability-config: 모르는 인자 ${a}\n${USAGE}`);
      return 2;
    }
  }
  if (!check) {
    console.error(USAGE);
    return 2;
  }
  let problems;
  try {
    problems = checkObservabilityConfig(root);
  } catch (e) {
    if (e instanceof ReadError) {
      console.error(`observability-config: 읽지 못했다: ${e.message}`);
      return 2;
    }
    throw e;
  }
  if (problems.length) {
    console.error(`observability-config: 관측 설정 위반 ${problems.length}건`);
    for (const p of problems) console.error(`막음: ${p}`);
    return 1;
  }
  console.log('observability-config: 통과(조직·데이터 소스·공급자·대시보드·보존·원격 쓰기·5분 규칙)');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
