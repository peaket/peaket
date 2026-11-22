#!/usr/bin/env node
// Grafana 조직·팀 멱등 적용(ADR-0356 결정 2, OPS-040, docs/observability.md §9 'Grafana 권한').
// 원천 deploy/platform/observability/grafana/access.yaml을 읽어 Grafana HTTP API로 없는 조직·팀만 만든다. 두 번 돌려도 같다.
// Grafana 파일 프로비저닝은 조직·팀을 만들지 않으므로(데이터 소스·대시보드 공급자는 orgId가 있는 조직이 이미 있어야 실린다) 이 스크립트가 먼저 돈다.
// - 조직: 이름으로 찾는다. 원천의 id와 다른 번호로 있으면 던진다(프로비저닝의 orgId가 어긋난다).
//   빈 Grafana의 1번 조직(Main Org.)은 1번 조직 이름으로 바꾼다(만든 것으로 센다)
// - 팀: 조직마다 이름(팀 slug)으로 찾고 없으면 만든다
// - 폴더·데이터 소스·대시보드는 파일 프로비저닝이 싣는다(provisioning/). 역할 연결(SSO 그룹)은 INF-020이 잇는다
// 로컬은 node tools/local/cluster.mjs observability가 부른다. 손으로:
//   PEAKET_GRAFANA_ADMIN_PASSWORD=<비밀번호> node tools/local/grafana-access.mjs --url http://127.0.0.1:3000 [--user admin] [--root <저장소>]
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ACCESS_FILE = 'deploy/platform/observability/grafana/access.yaml';
export const TEAMS_FILE = 'infra/stacks/global/github/teams.json';

/**
 * 원천을 읽어 적용할 꼴로 푼다: 팀 이름은 teams.json의 description, 팀 폴더 제목은 그 팀 이름.
 * 읽지 못하거나 꼴이 틀리면 던진다(검사 tools/ci/observability-config.mjs도 이 함수로 읽는다)
 * @returns {{ orgs: { id: number, name: string, restricted: boolean }[], teams: { slug: string, name: string, org: number }[],
 *   folders: { uid: string, title: string, org: number, team?: string }[], roles: { group: string, org: number, role: string }[] }}
 */
export function loadGrafanaAccess(root = REPO) {
  const file = join(root, ACCESS_FILE);
  if (!existsSync(file)) throw new Error(`${ACCESS_FILE}이 없다`);
  const src = parseYaml(readFileSync(file, 'utf8')) ?? {};
  const teamsFile = join(root, TEAMS_FILE);
  if (!existsSync(teamsFile)) throw new Error(`${TEAMS_FILE}이 없다`);
  const known = new Map(JSON.parse(readFileSync(teamsFile, 'utf8')).teams.map((t) => [t.slug, t.description]));
  const list = (k) => {
    if (!Array.isArray(src[k]) || src[k].length === 0) throw new Error(`${ACCESS_FILE}: ${k} 목록이 비었다`);
    return src[k];
  };
  const orgs = list('orgs').map((o) => {
    if (!Number.isInteger(o?.id) || o.id < 1 || typeof o.name !== 'string' || !o.name) throw new Error(`${ACCESS_FILE}: 조직에 id(1 이상 정수)·name이 없다: ${JSON.stringify(o)}`);
    return { id: o.id, name: o.name, restricted: o.restricted === true };
  });
  const orgIds = new Set(orgs.map((o) => o.id));
  const orgOf = (x, what) => {
    if (!orgIds.has(x?.org)) throw new Error(`${ACCESS_FILE}: ${what}의 org가 orgs에 없다: ${JSON.stringify(x)}`);
    return x.org;
  };
  const teams = list('teams').map((t) => {
    if (!known.has(t?.slug)) throw new Error(`${ACCESS_FILE}: 팀 ${t?.slug}이 ${TEAMS_FILE}에 없다`);
    return { slug: t.slug, name: known.get(t.slug), org: orgOf(t, `팀 ${t.slug}`) };
  });
  const folders = list('folders').map((f) => {
    if (typeof f?.uid !== 'string' || !/^[a-z0-9-]{1,40}$/.test(f.uid)) throw new Error(`${ACCESS_FILE}: 폴더 uid가 아니다: ${JSON.stringify(f)}`);
    if (f.team !== undefined && !teams.some((t) => t.slug === f.team)) throw new Error(`${ACCESS_FILE}: 폴더 ${f.uid}의 팀 ${f.team}이 teams에 없다`);
    const title = f.team !== undefined ? known.get(f.team) : f.title;
    if (typeof title !== 'string' || !title) throw new Error(`${ACCESS_FILE}: 폴더 ${f.uid}에 제목(title 또는 team)이 없다`);
    return { uid: f.uid, title, org: orgOf(f, `폴더 ${f.uid}`), ...(f.team !== undefined ? { team: f.team } : {}) };
  });
  const roles = (src.roles ?? []).map((r) => ({ group: String(r.group), org: orgOf(r, `역할 ${r.group}`), role: String(r.role) }));
  return { orgs, teams, folders, roles };
}

/**
 * 조직·팀을 없을 때만 만든다. 두 번째 실행은 { createdOrgs: 0, createdTeams: 0 }이다.
 * @param {{ baseUrl: string, auth: { user: string, password: string } | string, access: ReturnType<typeof loadGrafanaAccess>, fetch?: typeof fetch }} o
 *   auth는 기본 인증의 사용자·비밀번호(서버 관리자) 또는 Authorization 머리 값
 * @returns {Promise<{ createdOrgs: number, createdTeams: number }>}
 */
export async function applyGrafanaAccess({ baseUrl, auth, access, fetch: doFetch = globalThis.fetch }) {
  const authorization = typeof auth === 'string' ? auth : `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString('base64')}`;
  const base = baseUrl.replace(/\/+$/, '');
  const call = async (method, path, { body, org } = {}) => {
    const headers = { authorization, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (org !== undefined) headers['x-grafana-org-id'] = String(org);
    const res = await doFetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    if (!res.ok) throw new Error(`Grafana ${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  };

  let createdOrgs = 0;
  let createdTeams = 0;
  const existing = await call('GET', '/api/orgs?perpage=1000');
  if (!Array.isArray(existing)) throw new Error('Grafana GET /api/orgs가 목록이 아니다');
  const byName = new Map(existing.map((o) => [o.name, o.id]));
  const byId = new Map(existing.map((o) => [o.id, o.name]));
  for (const org of [...access.orgs].sort((a, b) => a.id - b.id)) {
    const found = byName.get(org.name);
    if (found !== undefined) {
      if (found !== org.id) throw new Error(`Grafana 조직 '${org.name}'의 번호가 ${found}이다(원천 ${org.id}). 프로비저닝 orgId가 어긋나 멈춘다`);
      continue;
    }
    const taken = byId.get(org.id);
    if (taken !== undefined) {
      // 빈 Grafana의 1번 조직(Main Org.)만 이름을 바꾼다. 다른 번호를 다른 이름이 쓰고 있으면 멈춘다
      if (org.id !== 1) throw new Error(`Grafana 조직 ${org.id}번을 다른 이름 '${taken}'이 쓰고 있다(원천 '${org.name}')`);
      await call('PUT', `/api/orgs/${org.id}`, { body: { name: org.name } });
    } else {
      const made = await call('POST', '/api/orgs', { body: { name: org.name } });
      if (made.orgId !== org.id) throw new Error(`Grafana가 조직 '${org.name}'을 ${made.orgId}번으로 만들었다(원천 ${org.id}). 프로비저닝 orgId가 어긋나 멈춘다`);
    }
    byName.set(org.name, org.id);
    byId.set(org.id, org.name);
    createdOrgs++;
  }
  for (const team of access.teams) {
    const found = await call('GET', `/api/teams/search?name=${encodeURIComponent(team.slug)}&perpage=10`, { org: team.org });
    if ((found.teams ?? []).some((t) => t.name === team.slug)) continue;
    await call('POST', '/api/teams', { body: { name: team.slug }, org: team.org });
    createdTeams++;
  }
  return { createdOrgs, createdTeams };
}

/**
 * 파일 프로비저닝을 다시 읽힌다(데이터 소스·대시보드 공급자). 조직을 만든 뒤 제한 조직 몫 파일로 바꿨을 때 부른다(tools/local/cluster.mjs observability)
 * @param {{ baseUrl: string, auth: { user: string, password: string } | string, fetch?: typeof fetch }} o
 */
export async function reloadGrafanaProvisioning({ baseUrl, auth, fetch: doFetch = globalThis.fetch }) {
  const authorization = typeof auth === 'string' ? auth : `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString('base64')}`;
  for (const what of ['datasources', 'dashboards']) {
    const res = await doFetch(`${baseUrl.replace(/\/+$/, '')}/api/admin/provisioning/${what}/reload`, { method: 'POST', headers: { authorization } });
    if (!res.ok) throw new Error(`Grafana 프로비저닝 다시 읽기(${what}) 실패: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}

async function main(argv) {
  let url;
  let user = 'admin';
  let root = REPO;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url' && argv[i + 1]) url = argv[++i];
    else if (a === '--user' && argv[i + 1]) user = argv[++i];
    else if (a === '--root' && argv[i + 1]) root = resolve(argv[++i]);
    else {
      console.error(`grafana-access: 모르는 인자 ${a}`);
      return 2;
    }
  }
  const password = process.env.PEAKET_GRAFANA_ADMIN_PASSWORD;
  if (!url || !password) {
    console.error('쓰는 법: PEAKET_GRAFANA_ADMIN_PASSWORD=<비밀번호> node tools/local/grafana-access.mjs --url <Grafana 주소> [--user admin] [--root <저장소>]');
    return 2;
  }
  const r = await applyGrafanaAccess({ baseUrl: url, auth: { user, password }, access: loadGrafanaAccess(root) });
  console.log(`grafana-access: 만든 조직 ${r.createdOrgs}개, 만든 팀 ${r.createdTeams}개`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`grafana-access: ${e.message}`);
      process.exit(1);
    },
  );
}
