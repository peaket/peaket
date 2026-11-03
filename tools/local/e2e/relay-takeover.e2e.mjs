// V-T28 ①의 kind 부분(docs/verification.md V-T28, ADR-0116, BUILD_ORDER FND-110, openspec 변경 add-local-cluster-and-relay-deployment).
// 실제 쿠버네티스 Lease API(서비스 계정 토큰·Role)와 Strimzi Kafka 3.9.1, PostgreSQL 18로 서비스별 Outbox 릴레이 두 복제를 돌린다.
// 쓰기를 흘리는 동안 리더 프로세스를 SIGSTOP으로 멈춰(묶음을 보내는 중일 수 있다) 다른 복제가 Lease를 이어받는지,
// 빠진 행이 없고 같은 키의 사건이 쓴 순서로 도착하는지, 깨어난 옛 리더가 리더로 돌아오지 않는지 본다.
// 부하(V-T27)를 건 전체 ①~③은 wbs 2.12.3에서 한다.
// 실행(저장소 뿌리): node tools/local/cluster.mjs up && node tools/local/cluster.mjs image && node --test tools/local/e2e/relay-takeover.e2e.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLUSTER, IMAGE, KUBECONFIG, kubectl } from '../cluster.mjs';
import { ensureTool } from '../tools.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const NS = 'example';
const SERVICE = 'example-svc';
const LEASE = `${SERVICE}-outbox-relay`;
const TOPIC = 'test.relay-takeover';
const ROWS = 600;
const KEYS = 5;
const RELAY_PASSWORD = 'peaket-local-relay'; // 합성 시험 값(클러스터 안에서만 닿는다)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const psql = (sqlText, db = 'example') =>
  kubectl(['-n', 'peaket-local', 'exec', '-i', 'deploy/postgres', '--', 'psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-qtA', '-f', '-'], { input: sqlText });
const kafkaExec = (args) => kubectl(['-n', 'kafka', 'exec', 'peaket-dual-0', '-c', 'kafka', '--', ...args]);
const holder = async () => (await kubectl(['-n', NS, 'get', 'lease', LEASE, '-o', 'jsonpath={.spec.holderIdentity}'], { quiet: true })).trim();
const relayPods = async () =>
  JSON.parse(await kubectl(['-n', NS, 'get', 'pods', '-l', 'app.kubernetes.io/component=outbox-relay', '-o', 'json'])).items.filter((p) => !p.metadata.deletionTimestamp);
const metrics = async (pod) =>
  kubectl(['-n', NS, 'exec', pod, '--', 'node', '-e', "fetch('http://127.0.0.1:9464/metrics').then(r=>r.text()).then(t=>process.stdout.write(t))"], { quiet: true });
const restarts = async (name) => JSON.parse(await kubectl(['-n', NS, 'get', 'pod', name, '-o', 'json'])).status.containerStatuses[0].restartCount;
const isLeaderMetric = (text) => Number(/^outbox_relay_is_leader\{service="example-svc"\} (\d)$/m.exec(text)?.[1]);

/** 파드의 컨테이너 프로세스에 신호를 보낸다(kind 노드 컨테이너 안에서. 컨테이너 안의 PID 1에는 SIGSTOP이 닿지 않는다) */
async function signal(pod, sig) {
  const id = pod.status.containerStatuses[0].containerID.replace(/^containerd:\/\//, '');
  const node = `${CLUSTER}-control-plane`;
  const pid = execFileSync('docker', ['exec', node, 'crictl', 'inspect', '--output', 'go-template', '--template', '{{.info.pid}}', id], { encoding: 'utf8' }).trim();
  // 0은 프로세스가 없다는 뜻이다(컨테이너가 다시 떴으면 옛 ID로 0이 나온다). kill 0은 엉뚱한 프로세스 묶음에 간다(코드 리뷰 2026-11-01)
  assert.match(pid, /^[1-9]\d*$/, `프로세스 번호가 없다: ${pid}`);
  execFileSync('docker', ['exec', node, 'kill', `-${sig}`, pid]);
}

async function until(what, cond, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`기다림 한도: ${what}`);
    await sleep(500);
  }
}

test('V_T28_1_FND110_kind_리더를SIGSTOP으로멈추면_다른복제가Lease를이어받고_빠짐과키순서뒤집힘이없다', { timeout: 600_000 }, async () => {
  const helm = await ensureTool('helm');
  // ---- 준비: DB·역할·토픽(다시 돌려도 처음부터) ----
  execFileSync(helm, ['--kubeconfig', KUBECONFIG, 'uninstall', 'example', '-n', NS, '--wait', '--ignore-not-found'], { stdio: 'inherit' });
  await kubectl(['delete', 'lease', LEASE, '-n', NS, '--ignore-not-found']).catch(() => {});
  await psql(`drop database if exists example with (force); drop role if exists example_svc_outbox_relay;
    create role example_svc_outbox_relay login password '${RELAY_PASSWORD}'; create database example;`, 'peaket');
  const migrations = ['0000_example_note.sql', '0001_idempotency_record.sql', '0002_outbox.sql', '0003_held_event_and_stat_snapshot.sql']
    .map((f) => readFileSync(join(REPO, 'packages', 'platform', 'template', 'migrations', f), 'utf8'))
    .join('\n');
  await psql(migrations);
  // 릴레이 전용 역할: Outbox 읽기와 sent_at 고치기만(docs/data.md §4의 7번, ASVS v5.0.0-13.2.2). 정비는 소유자 역할(정비 역할은 BAS-060)
  await psql(`grant usage on schema public to example_svc_outbox_relay;
    grant select, update (sent_at) on outbox to example_svc_outbox_relay;`);
  await kafkaExec(['bin/kafka-topics.sh', '--bootstrap-server', 'localhost:9092', '--delete', '--topic', TOPIC, '--if-exists']);
  await until('토픽 지움', async () => !(await kafkaExec(['bin/kafka-topics.sh', '--bootstrap-server', 'localhost:9092', '--list'])).split('\n').includes(TOPIC), 60_000);
  await kafkaExec(['bin/kafka-topics.sh', '--bootstrap-server', 'localhost:9092', '--create', '--topic', TOPIC, '--partitions', '3', '--replication-factor', '1']);

  // ---- 차트 설치: 서비스 1복제(준비 프로브 /ready) + 릴레이 2복제 ----
  const pg = (user, pw) => `postgres://${user}:${pw}@postgres.peaket-local.svc:5432/example`;
  const [repo, tag] = IMAGE.split(':');
  execFileSync(
    helm,
    [
      '--kubeconfig', KUBECONFIG, 'upgrade', '--install', 'example', join(REPO, 'deploy', 'charts', 'peaket-service'),
      '-n', NS, '--create-namespace', '--wait', '--timeout', '300s',
      '--set', `name=${SERVICE}`, '--set', `image.repository=${repo}`, '--set', `image.tag=${tag}`, '--set', 'image.pullPolicy=Never',
      '--set', 'env.PEAKET_ENV=local', '--set', 'service.replicas=1',
      '--set', `service.env.PEAKET_DATABASE_URL=${pg('postgres', 'peaket-local')}`,
      '--set', 'outboxRelay.enabled=true',
      '--set', `outboxRelay.env.PEAKET_OUTBOX_DATABASE_URL=${pg('example_svc_outbox_relay', RELAY_PASSWORD)}`,
      '--set', `outboxRelay.env.PEAKET_MAINTENANCE_DATABASE_URL=${pg('postgres', 'peaket-local')}`,
      '--set', 'outboxRelay.env.PEAKET_KAFKA_BROKERS=peaket-kafka-bootstrap.kafka.svc:9092',
    ],
    { stdio: 'inherit' },
  );

  // 실제 Lease API로 리더 하나가 선다(파드 이름 = PEAKET_POD)
  const pods = await relayPods();
  assert.equal(pods.length, 2);
  const first = await until('리더', holder, 60_000);
  const leaderPod = pods.find((p) => p.metadata.name === first);
  assert.ok(leaderPod, `Lease 보유자 ${first}가 릴레이 파드가 아니다`);
  const standby = pods.find((p) => p !== leaderPod);
  assert.equal(isLeaderMetric(await metrics(leaderPod.metadata.name)), 1);
  assert.equal(isLeaderMetric(await metrics(standby.metadata.name)), 0);
  // 리더가 되자마자 정비가 돌아 Outbox 일 파티션을 만든다(정비 반복을 깨운다)
  await until('Outbox 파티션', async () => Number((await psql("select count(*) from pg_inherits where inhparent = 'outbox'::regclass;")).trim()) >= 7, 60_000);

  // ---- 쓰기를 흘리며 리더를 멈춘다 ----
  const writerSql = `do $$ begin for i in 1..${ROWS} loop
      insert into outbox (id, topic, msg_key, payload) values (uuidv7(), '${TOPIC}', 'k-' || (i % ${KEYS}), convert_to(i::text, 'UTF8'));
      commit; perform pg_sleep(0.01); end loop; end $$;`;
  const k = await ensureTool('kubectl');
  const writer = spawn(k, ['--kubeconfig', KUBECONFIG, '-n', 'peaket-local', 'exec', '-i', 'deploy/postgres', '--', 'psql', '-U', 'postgres', '-d', 'example', '-v', 'ON_ERROR_STOP=1', '-qtA', '-f', '-'], { stdio: ['pipe', 'inherit', 'inherit'] });
  writer.stdin.end(writerSql);
  const writerDone = new Promise((res, rej) => writer.on('exit', (c) => (c === 0 ? res() : rej(new Error(`쓰기 실패 ${c}`)))));
  await sleep(1_500);
  const restartsBefore = await restarts(leaderPod.metadata.name);
  await signal(leaderPod, 'STOP');
  const stoppedAt = Date.now();
  let resumed = false;
  let next;
  let takeoverMs;
  let stoppedMs;
  try {
    next = await until('Lease 이어받기', async () => {
      const h = await holder();
      return h && h !== first ? h : undefined;
    }, 60_000);
    takeoverMs = Date.now() - stoppedAt;
    assert.equal(next, standby.metadata.name);
    console.log(`# 리더가 바뀌는 데 걸린 시간: ${takeoverMs}ms (Lease 12초·다시 시도 2초 [가정], 정본 '15초 안')`);
    assert.ok(takeoverMs <= 20_000, `이어받기 ${takeoverMs}ms`);
    await writerDone;
    // 멈춘 리더가 묶음 트랜잭션을 쥐고 있었다면 새 리더는 그 행의 잠금을 기다린다. 트랜잭션은 쉬는 한도(30초 [가정])에 DB가 끊는다
    await until('보내지 않은 행 0', async () => (await psql('select count(*) from outbox where sent_at is null;')).trim() === '0', 120_000);
    stoppedMs = Date.now() - stoppedAt;

    // ---- 옛 리더를 깨운다 ----
    await signal(leaderPod, 'CONT');
    resumed = true;
  } finally {
    // 앞의 단정이 실패해도 멈춘 프로세스를 남기지 않는다
    if (!resumed) await signal(leaderPod, 'CONT').catch(() => {});
  }
  // 멈춘 동안 생존 프로브 한도(약 1분)를 넘겨 컨테이너가 다시 떴다면, 아래 확인은 깨어난 옛 리더가 아니라 새 프로세스를 보게 된다
  assert.equal(await restarts(leaderPod.metadata.name), restartsBefore, '멈춘 리더 컨테이너가 다시 떴다(멈춘 시간이 생존 프로브 한도를 넘었다)');
  await sleep(8_000);
  assert.equal(await holder(), next, '깨어난 옛 리더가 Lease를 되가져가면 안 된다');
  // 릴레이가 고치기(PUT)를 거듭해도 차트가 붙인 라벨·주석이 남는다(지우면 ArgoCD가 계속 어긋남으로 본다, 코드 리뷰 2026-11-01)
  const meta = JSON.parse(await kubectl(['-n', NS, 'get', 'lease', LEASE, '-o', 'json'])).metadata;
  assert.equal(meta.labels?.['app.kubernetes.io/name'], SERVICE);
  assert.equal(meta.annotations?.['meta.helm.sh/release-name'], 'example');
  assert.equal(isLeaderMetric(await metrics(leaderPod.metadata.name)), 0);
  assert.equal(isLeaderMetric(await metrics(next)), 1);
  assert.equal((await psql('select count(*) from outbox where sent_at is null;')).trim(), '0');

  // ---- 받는 쪽: 빠짐 0, 같은 키는 쓴 순서(다시 보낸 것은 처음 나온 자리로 본다) ----
  const out = await kafkaExec([
    'bin/kafka-console-consumer.sh', '--bootstrap-server', 'localhost:9092', '--topic', TOPIC, '--from-beginning',
    '--timeout-ms', '15000', '--property', 'print.key=true', '--property', 'key.separator=|',
  ]).catch((e) => String(e.stdout ?? ''));
  const got = out.split('\n').filter((l) => l.includes('|')).map((l) => {
    const [key, n] = l.trim().split('|');
    return { key, n: Number(n) };
  });
  const distinct = new Set(got.map((g) => g.n));
  assert.equal(distinct.size, ROWS, `받은 서로 다른 행 ${distinct.size}/${ROWS}`);
  let inversions = 0;
  for (let i = 0; i < KEYS; i++) {
    const seen = new Set();
    let last = 0;
    for (const g of got.filter((x) => x.key === `k-${i}`)) {
      if (seen.has(g.n)) continue; // 다시 보낸 사건
      seen.add(g.n);
      if (g.n < last) inversions += 1;
      last = g.n;
    }
  }
  console.log(`# 받은 메시지 ${got.length}건(서로 다른 행 ${distinct.size}, 다시 보낸 것 ${got.length - distinct.size}), 멈춘 시간 ${stoppedMs}ms, 순서 뒤집힘 ${inversions}`);
  assert.equal(inversions, 0);
});
