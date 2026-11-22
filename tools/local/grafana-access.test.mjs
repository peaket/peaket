// Grafana 조직·팀 멱등 적용(OPS-040, ADR-0356 결정 2, docs/observability.md §9 'Grafana 권한'). 장부 항목이 아니라 단계 ID를 단다(계획 §6).
// 가짜 Grafana API(node:http)를 띄우고 적용 함수와 명령줄을 그 주소로 돌린다. 가짜는 이 스크립트가 쓰는 Grafana HTTP API의 모양을 따른다
// (Grafana 문서 'Organization HTTP API'·'Team HTTP API': GET /api/orgs는 [{id, name}], POST /api/orgs는 {orgId, message}, 팀 찾기
// GET /api/teams/search?name=는 X-Grafana-Org-Id 머리의 조직 안에서 이름이 같은 팀을 {totalCount, teams, page, perPage}로, POST /api/teams는 {teamId, message},
// 같은 이름은 409. 서버 관리자 기본 인증이 틀리면 401). 빈 Grafana에는 1번 조직 'Main Org.'만 있다.
// 기대 값(조직 이름 둘, 팀 목록)은 정본(§9)과 원천 파일(access.yaml)을 시험이 직접 읽어 정한다.
// 실행(저장소 뿌리): node --test tools/local/grafana-access.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { applyGrafanaAccess, loadGrafanaAccess } from './grafana-access.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const SCRIPT = join(HERE, 'grafana-access.mjs');
const ADMIN = { user: 'admin', password: 'local-admin-pw-for-fake-grafana' };
/** 원천 파일을 시험이 직접 읽은 것 */
const SOURCE = parse(readFileSync(join(REPO, 'deploy/platform/observability/grafana/access.yaml'), 'utf8'));
/** docs/observability.md §9 'Grafana 권한'의 조직 둘 */
const ORGS = [
  [1, 'PEAKET 관측'],
  [2, 'PEAKET 제한'],
];

/** 가짜 Grafana. orgs·teams 시작 상태를 받는다. writes는 쓰기 요청(POST·PUT·DELETE) 기록 */
async function fakeGrafana({ orgs = [{ id: 1, name: 'Main Org.' }], teams = [] } = {}) {
  const state = { orgs: orgs.map((o) => ({ ...o })), teams: teams.map((t) => ({ ...t })), writes: [], unauthorized: 0 };
  let nextOrg = Math.max(...state.orgs.map((o) => o.id)) + 1;
  let nextTeam = 1;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const expected = `Basic ${Buffer.from(`${ADMIN.user}:${ADMIN.password}`).toString('base64')}`;
      if (req.headers.authorization !== expected) {
        state.unauthorized++;
        return send(401, { message: 'Unauthorized' });
      }
      const u = new URL(req.url, 'http://grafana');
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      if (req.method !== 'GET') state.writes.push(`${req.method} ${u.pathname}`);
      // 요청의 조직(서버 관리자는 X-Grafana-Org-Id로 바꾼다, 없으면 1번)
      const orgId = Number(req.headers['x-grafana-org-id'] ?? 1);
      if (!state.orgs.some((o) => o.id === orgId)) return send(403, { message: 'Access denied to organization' });
      if (req.method === 'GET' && u.pathname === '/api/orgs') return send(200, state.orgs.map((o) => ({ id: o.id, name: o.name })));
      if (req.method === 'POST' && u.pathname === '/api/orgs') {
        if (state.orgs.some((o) => o.name === body.name)) return send(409, { message: 'Organization name taken' });
        const id = nextOrg++;
        state.orgs.push({ id, name: body.name });
        return send(200, { orgId: id, message: 'Organization created' });
      }
      const put = /^\/api\/orgs\/(\d+)$/.exec(u.pathname);
      if (req.method === 'PUT' && put) {
        const o = state.orgs.find((x) => x.id === Number(put[1]));
        if (!o) return send(404, { message: 'Organization not found' });
        if (state.orgs.some((x) => x.name === body.name && x !== o)) return send(409, { message: 'Organization name taken' });
        o.name = body.name;
        return send(200, { message: 'Organization updated' });
      }
      if (req.method === 'GET' && u.pathname === '/api/teams/search') {
        const name = u.searchParams.get('name');
        const found = state.teams.filter((t) => t.orgId === orgId && (name === null || t.name === name));
        return send(200, { totalCount: found.length, teams: found.map((t) => ({ id: t.id, orgId: t.orgId, name: t.name, email: '', memberCount: 0 })), page: 1, perPage: Number(u.searchParams.get('perpage') ?? 1000) });
      }
      if (req.method === 'POST' && u.pathname === '/api/teams') {
        if (state.teams.some((t) => t.orgId === orgId && t.name === body.name)) return send(409, { message: 'Team name taken' });
        const id = nextTeam++;
        state.teams.push({ id, orgId, name: body.name });
        return send(200, { message: 'Team created', teamId: id });
      }
      return send(404, { message: 'Not found' });
    });
  });
  // real-time: 적용 스크립트는 fetch로 Grafana HTTP API를 부른다. 그 요청 모양(경로·머리·본문)을 실제 HTTP로 받아 본다(빈 포트 0, 127.0.0.1) OPS-040
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => {
      server.closeAllConnections();
      server.close(r);
    }),
  };
}

/** 명령줄을 비동기로 돌린다(가짜 Grafana가 같은 프로세스에서 답하므로 spawnSync를 쓰지 않는다) */
function cliAsync(args, env) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: REPO, env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (status) => resolveRun({ status, out }));
  });
}

const teamsOf = (state, orgId) => state.teams.filter((t) => t.orgId === orgId).map((t) => t.name).sort();

test('OPS-040 적용을 두 번 해도 조직·팀이 한 번만 생긴다', async () => {
  const g = await fakeGrafana();
  try {
    const access = loadGrafanaAccess(REPO);
    const first = await applyGrafanaAccess({ baseUrl: g.url, auth: ADMIN, access });
    // 빈 Grafana: 1번 조직 이름을 바꾸고(만든 것으로 센다) 제한 조직을 만든다. 팀은 원천의 가상 팀 전부
    assert.deepEqual(first, { createdOrgs: 2, createdTeams: SOURCE.teams.length });
    assert.deepEqual(g.state.orgs.map((o) => [o.id, o.name]), ORGS);
    for (const [id] of ORGS) assert.deepEqual(teamsOf(g.state, id), SOURCE.teams.filter((t) => t.org === id).map((t) => t.slug).sort());
    assert.ok(SOURCE.teams.length >= 1);
    const writesAfterFirst = g.state.writes.length;
    assert.equal(writesAfterFirst, 2 + SOURCE.teams.length);
    // 두 번째 실행은 아무것도 만들지 않고 쓰기 요청도 0이다
    const second = await applyGrafanaAccess({ baseUrl: g.url, auth: ADMIN, access });
    assert.deepEqual(second, { createdOrgs: 0, createdTeams: 0 });
    assert.equal(g.state.writes.length, writesAfterFirst);
    assert.equal(g.state.unauthorized, 0);
  } finally {
    await g.close();
  }
});

test('OPS-040 이미 있는 조직·팀은 두고 빠진 것만 만들며, 조직 번호가 원천과 어긋나면 멈춘다', async () => {
  const access = loadGrafanaAccess(REPO);
  const [someTeam] = SOURCE.teams;
  const partial = await fakeGrafana({ orgs: ORGS.map(([id, name]) => ({ id, name })), teams: [{ id: 50, orgId: someTeam.org, name: someTeam.slug }] });
  try {
    assert.deepEqual(await applyGrafanaAccess({ baseUrl: partial.url, auth: ADMIN, access }), { createdOrgs: 0, createdTeams: SOURCE.teams.length - 1 });
    assert.ok(!partial.state.writes.some((w) => w.includes('/api/orgs')), partial.state.writes.join(','));
  } finally {
    await partial.close();
  }
  // 2번을 다른 조직이 쓰고 있으면 제한 조직이 3번으로 생겨 프로비저닝 orgId가 어긋난다: 만들지 않고 멈춘다
  const taken = await fakeGrafana({ orgs: [{ id: 1, name: 'PEAKET 관측' }, { id: 2, name: '다른 조직' }] });
  try {
    await assert.rejects(applyGrafanaAccess({ baseUrl: taken.url, auth: ADMIN, access }), /2번|다른 이름|어긋/);
    assert.ok(!taken.state.orgs.some((o) => o.id === 3), JSON.stringify(taken.state.orgs));
  } finally {
    await taken.close();
  }
  // 관리자 인증이 틀리면 던진다(조용히 0을 돌려주지 않는다)
  const g = await fakeGrafana();
  try {
    await assert.rejects(applyGrafanaAccess({ baseUrl: g.url, auth: { user: 'admin', password: 'wrong' }, access }), /401/);
    assert.deepEqual(g.state.writes, []);
  } finally {
    await g.close();
  }
});

test('OPS-040 명령줄 적용도 두 번째는 0개이고, 관리자 비밀번호가 없으면 2다', async () => {
  const g = await fakeGrafana();
  try {
    const env = { PEAKET_GRAFANA_ADMIN_PASSWORD: ADMIN.password };
    const a = await cliAsync(['--url', g.url], env);
    assert.equal(a.status, 0, a.out);
    assert.match(a.out, new RegExp(`만든 조직 2개, 만든 팀 ${SOURCE.teams.length}개`));
    const b = await cliAsync(['--url', g.url], env);
    assert.equal(b.status, 0, b.out);
    assert.match(b.out, /만든 조직 0개, 만든 팀 0개/);
    // 비밀번호는 화면에 찍지 않는다
    assert.doesNotMatch(a.out + b.out, new RegExp(ADMIN.password));
    const none = await cliAsync(['--url', g.url], { PEAKET_GRAFANA_ADMIN_PASSWORD: '' });
    assert.equal(none.status, 2, none.out);
  } finally {
    await g.close();
  }
});
