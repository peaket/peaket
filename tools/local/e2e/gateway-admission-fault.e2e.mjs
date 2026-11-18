// 게이트웨이 입장 토큰 키 목록의 장애와 되살림(복구 경로 장애 주입) kind 시험(BUILD_ORDER HOT-400 묶음 BAT-057 계획 §6 K13, Q-T69 ②).
// 정본: docs/infra.md §4.1 '입장 토큰 확인'의 '키'(프록시 환경 값 PEAKET_ADMISSION_JWKS, ConfigMap peaket-admission-jwks의 jwks, optional: true. 값이 없거나 읽지 못하거나
// 쓸 키가 없으면 모든 입장 토큰을 거절하고(닫힌 쪽) 경고 로그를 남긴다. ConfigMap이 없어도 프록시는 뜬다), ADR-0288 결정 5.
// 차례: 처음 값에서 통과 → 빈 묶음({"keys":[]}) → ConfigMap 지움 → 깨진 JSON → 처음 값 되돌림. 장애마다 지금·다음·옛 키 토큰이 모두 401이고(접근 로그에 그 401 줄이 실제로
// 있다), gw-fan의 입장 토큰을 쓰지 않는 경로(api·www 앱 서버)와 다른 게이트웨이 넷은 그대로이며, 프록시가 그 까닭을 경고 로그로 남긴다. 되돌린 뒤 다시 통과한다.
// 키 목록 바꾸기는 node tools/local/cluster.mjs gateways-admission restore|empty|remove(gw-fan 프록시를 다시 띄워 옛 파드가 사라질 때까지 기다린다)이고,
// 깨진 JSON은 이 시험이 ConfigMap을 직접 고친 뒤 같은 방법으로 다시 띄운다. gw-fan 프록시를 다시 띄우므로 같은 클러스터의 게이트웨이 시험 맨 끝에 돈다.
// 실행(저장소 뿌리, Docker 차례 잠금을 잡고): gateway-admission.e2e.mjs와 같은 바탕에서 node --test tools/local/e2e/gateway-admission-fault.e2e.mjs
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kubectl } from '../cluster.mjs';
import { GATEWAYS, accessToken, admissionToken, echoed, edge, loadContract, probe, send, waitLogLine } from './gateway-client.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const INVALID_BODY = { type: 'https://peaket.example/problems/admission-token-invalid', title: '입장 확인이 끝났습니다', status: 401 };
const CONFIGMAP = 'peaket-admission-jwks';
const NS = 'envoy-gateway-system';
const GW_FAN = 'gateway.envoyproxy.io/owning-gateway-name=gw-fan';
const RUN = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
let c;
let n = 0;
const nextSub = () => `fault-${RUN}-${++n}`;
const nextIp = () => `203.0.113.${1 + (n++ % 250)}`;
/** 장애 주입을 실제로 했는지(맨 끝에 처음 값으로 되돌린다) */
let changed = false;

before(() => {
  c = loadContract();
});
// 중간에 실패해도 다른 시험이 쓰는 처음 값으로 되돌린다
after(() => {
  if (changed) admissionCommand('restore');
});

function admissionCommand(mode) {
  const r = spawnSync(process.execPath, [join(REPO, 'tools', 'local', 'cluster.mjs'), 'gateways-admission', mode], { cwd: REPO, encoding: 'utf8', env: process.env, timeout: 600_000 });
  return { status: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}
async function run(mode) {
  changed = true;
  const r = admissionCommand(mode);
  assert.equal(r.status, 0, `cluster.mjs gateways-admission ${mode}: 종료 ${r.status}\n${r.out.slice(-1500)}`);
}

/** 깨진 JSON을 넣고 gw-fan 프록시를 다시 띄운다(cluster.mjs gateways-admission과 같은 차례: 다시 띄우기 → 준비 → 옛 파드가 사라짐) */
async function broken() {
  changed = true;
  const cm = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: CONFIGMAP, namespace: NS }, data: { jwks: '{"keys":[' } };
  await kubectl(['apply', '-f', '-'], { input: JSON.stringify(cm) });
  const deploys = (await kubectl(['-n', NS, 'get', 'deploy', '-l', GW_FAN, '-o', 'name'], { quiet: true })).split('\n').filter(Boolean);
  const pods = (await kubectl(['-n', NS, 'get', 'pods', '-l', GW_FAN, '-o', 'name'], { quiet: true })).split('\n').filter(Boolean);
  assert.ok(deploys.length > 0, 'gw-fan 프록시 Deployment가 없다');
  await kubectl(['-n', NS, 'rollout', 'restart', ...deploys]);
  for (const d of deploys) await kubectl(['-n', NS, 'rollout', 'status', d, '--timeout=300s']);
  if (pods.length) await kubectl(['-n', NS, 'wait', '--for=delete', ...pods, '--timeout=300s']);
  // 다섯 포트가 다시 TLS로 답할 때까지(최대 60초)
  const until = Date.now() + 60_000;
  for (;;) {
    try {
      await send(c, 'api', { path: '/v1/zz-ready', headers: edge(c, nextIp()) });
      return;
    } catch (e) {
      if (Date.now() > until) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/** gw-fan 프록시 로그(접근 로그가 아닌 줄 포함, since 초 안) */
async function proxyLog(sinceSeconds = 600) {
  return kubectl(['-n', NS, 'logs', '-l', GW_FAN, '-c', 'envoy', `--since=${sinceSeconds}s`, '--tail=-1', '--prefix=false'], { quiet: true, maxBuffer: 256 * 1024 * 1024, timeout: 60_000 });
}

const isEcho = (r) => {
  try {
    echoed(r);
    return true;
  } catch {
    return false;
  }
};
/** 그 키로 만든 입장 토큰의 스냅샷 요청(회차는 부른 단계마다 다르다: 접근 로그 줄을 고른다) */
const buyWith = (key, event) => send(c, 'api', { path: `/v1/events/${event}/seatmap-snapshot`, headers: edge(c, nextIp(), { authorization: `Bearer ${accessToken(c, 'gw-fan', nextSub())}`, 'x-admission-token': admissionToken(c, { event, key }) }) });

/** 입장 토큰을 쓰지 않는 길(gw-fan api 일반 경로·www 앱 서버, 다른 게이트웨이 넷의 확인 경로)이 그대로 대역에 닿는다 */
async function othersUnaffected(label) {
  const api = await send(c, 'api', { path: '/v1/tickets', headers: edge(c, nextIp(), { authorization: `Bearer ${accessToken(c, 'gw-fan', nextSub())}` }) });
  assert.ok(api.status < 400 && isEcho(api), `${label}: gw-fan api 일반 경로 ${api.status} ${api.text.slice(0, 160)}`);
  const app = await send(c, 'www', { path: c.appPaths['gw-fan'], headers: edge(c, nextIp()) });
  assert.ok(app.status < 400 && isEcho(app), `${label}: gw-fan www 앱 서버 ${app.status} ${app.text.slice(0, 160)}`);
  for (const gw of GATEWAYS.filter((g) => g !== 'gw-fan')) {
    const r = await probe(c, gw, { tokenValue: accessToken(c, gw, nextSub()), event: `${RUN}-${gw}`, headers: edge(c, nextIp()) });
    assert.ok(r.status < 400 && isEcho(r), `${label}: ${gw} 확인 경로 ${r.status} ${r.text.slice(0, 160)}`);
  }
}

/** 장애 동안: 지금·다음·끝 시각이 남은 옛 키 토큰이 모두 401이고, 그 401이 접근 로그에 있으며, 경고 로그가 있다 */
async function allRejected(stage) {
  for (const key of ['current', 'next', 'previous']) {
    const event = `${RUN}-${stage}-${key}`;
    const r = await buyWith(key, event);
    assert.equal(r.status, 401, `${stage} ${key}: ${r.status} ${r.text.slice(0, 160)}`);
    assert.ok(!isEcho(r), `${stage} ${key}: 대역에 닿았다(열린 쪽 실패)`);
    assert.deepEqual(JSON.parse(r.text), INVALID_BODY, `${stage} ${key}: 본문`);
    const lines = await waitLogLine(c, 'gw-fan', `/v1/events/${event}/seatmap-snapshot`);
    assert.ok(lines.some((l) => String(l.status) === '401'), `${stage} ${key}: 접근 로그에 401 줄이 없다 ${JSON.stringify(lines.map((l) => l.status))}`);
  }
  const log = await proxyLog();
  assert.match(log, /peaket admission jwks unusable/, `${stage}: 키를 쓸 수 없다는 경고 로그가 없다`);
  await othersUnaffected(stage);
}

test('Q-T69 ② (복구 경로 장애 주입) 게이트웨이 키 목록이 비거나(empty)·없거나(remove)·깨지면 모든 입장 토큰이 401이고 접근 로그에 그 401이 있으며, gw-fan의 다른 경로와 다른 게이트웨이는 그대로다. restore 뒤 다시 통과한다', async () => {
  assert.ok(c.admission, '접속 정보에 admission 칸이 없다(입장 토큰 시험 키 넷, BAT-057 계획 §5): node tools/local/cluster.mjs gateways가 만들지 않았다');
  // 처음 값: 지금 키 토큰이 대역에 닿는다
  {
    const r = await buyWith('current', `${RUN}-start`);
    assert.ok(r.status < 400 && isEcho(r), `처음 값: ${r.status} ${r.text.slice(0, 160)}`);
  }
  await othersUnaffected('처음 값');

  await run('empty');
  await allRejected('empty');

  await run('remove');
  // ConfigMap이 정말 없다(optional: true라 프록시는 떴다)
  const cms = await kubectl(['-n', NS, 'get', 'configmap', CONFIGMAP, '--ignore-not-found', '-o', 'name'], { quiet: true });
  assert.equal(cms.trim(), '', 'remove 뒤에도 ConfigMap이 있다');
  await allRejected('remove');

  await broken();
  await allRejected('broken');

  await run('restore');
  changed = false;
  for (const key of ['current', 'next', 'previous']) {
    const r = await buyWith(key, `${RUN}-restore-${key}`);
    assert.ok(r.status < 400 && isEcho(r), `restore 뒤 ${key}: ${r.status} ${r.text.slice(0, 160)}`);
  }
  const expired = await buyWith('expired', `${RUN}-restore-expired`);
  assert.equal(expired.status, 401, `restore 뒤 끝 시각이 지난 옛 키: ${expired.status}`);
  await othersUnaffected('restore');
});
