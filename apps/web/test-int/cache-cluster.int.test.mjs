// 공유 캐시 클러스터 연결·회복 통합 시험(BAT-170 웨이브 끝 리뷰 W7L2-K1·K2 재현, 계획 §14 K-2, docs/frontend.md §5.18 '클러스터 연결과 회복').
// 시험 담당(l2w7-BAT170-test)이 구현 전에 썼다(ADR-0270 결정 3). Valkey 주 노드 셋·복제 셋 클러스터 컨테이너
// (services/queue-svc/test-sim/cluster.ts와 같은 방식: 노드는 컨테이너 망 이름을 알리고, 이 PC는 nodeAddressMap으로 노드마다 연 포트로 바꿔 붙는다).
// 파일 이름 꼴(docs/devops.md §3.1): *.int.test.mjs는 Valkey만 쓴다(운영 빌드를 읽지 않는다). 컨테이너 이름 머리는 lane2-bat170t-이고 끝나면 docker rm -f -v로 지운다.
// 일부러 멈추는 시험은 docker pause/unpause만 쓴다(restart 금지).
// 실행: apps/web에서 node --test test-int/cache-cluster.int.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { createClient } from 'redis';
import { createCacheStore } from '../server/cache-store.mjs';
import { createUseCacheHandler } from '../server/use-cache-handler.mjs';

const VALKEY_IMAGE = 'valkey/valkey:8.1-alpine';
/** 정본: 모든 키 TTL 상한 30일 [가정] */
const DAYS_30_S = 30 * 24 * 60 * 60;
/** 정본(W7L2-S10, docs/frontend.md §5.18 TTL 문장): 값 TTL 상한 기본 1시간 [가정], 태그 시각은 30일 */
const HOUR_S = 3_600;
/** 정본: 명령 시간 한도 100ms, 실제 시계 여유 50ms(계획 §14 K-2) */
const CMD_LIMIT_MS = 100 + 50;
const NET = `lane2-bat170t-net-${process.pid}`;
const NAMES = [1, 2, 3, 4, 5, 6].map((i) => `lane2-bat170t-k${i}-${process.pid}`);
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim();
const tryDocker = (...args) => {
  try {
    return docker(...args);
  } catch {
    return null;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cli = (node, ...args) => docker('exec', node, 'valkey-cli', ...args);
const nodeAddressMap = {};
let urls;
const paused = new Set();
const stores = [];

/** Valkey 키 슬롯(CRC16 XMODEM % 16384, 해시 태그 {…}가 있으면 그 안만). docker exec 없이 이 프로세스에서 센다 */
function keySlot(key) {
  const open = key.indexOf('{');
  if (open >= 0) {
    const close = key.indexOf('}', open + 1);
    if (close > open + 1) key = key.slice(open + 1, close);
  }
  let crc = 0;
  for (const b of Buffer.from(key)) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc % 16384;
}

/** 지금 슬롯 표(CLUSTER NODES 한 번): 주 노드마다 슬롯 범위와 그 복제 */
function slotTable() {
  const text = NAMES.filter((n) => !paused.has(n)).map((n) => tryDocker('exec', n, 'valkey-cli', 'CLUSTER', 'NODES')).find((x) => x) ?? '';
  const rows = text.split('\n').map((l) => l.trim().split(' '));
  const hostOf = (r) => (r[1] ?? '').split(',')[1] ?? '';
  return rows
    .filter((r) => r[2]?.includes('master') && !r[2]?.includes('fail'))
    .map((m) => {
      const replica = rows.find((r) => r[3] === m[0] && r[2]?.includes('slave') && !r[2]?.includes('fail'));
      const ranges = m.slice(8).map((x) => x.split('-').map(Number)).map(([a, b]) => [a, b ?? a]);
      return { master: hostOf(m), replica: replica ? hostOf(replica) : null, ranges };
    });
}

/** 그 키 슬롯의 주 노드와 복제(컨테이너 이름). 표를 주지 않으면 새로 읽는다 */
function ownerOf(key, table = slotTable()) {
  const slot = keySlot(key);
  const row = table.find((t) => t.ranges.some(([a, b]) => slot >= a && slot <= b));
  if (!row) throw new Error(`슬롯 ${slot}의 주 노드를 찾지 못했다`);
  return { master: row.master, replica: row.replica };
}

// 시험 이의 O-1(계획 '## 시험 이의', 정본 docs/frontend.md §5.18 ⓓ '붙는 동안의 요청은 기다리지 않고 없음·버림'): 막 만든 저장소는 처음 연결이 끝날 때까지
// 요청을 버리므로, 처리기 모듈이 불러올 때 하듯 ready()로 처음 연결을 기다린 뒤 쓴다. 슬롯 주인은 이 프로세스에서 센 슬롯과 CLUSTER NODES 한 번으로 저장소를 만들기 전에 구해
// 이벤트 루프를 막아 연결 시간 한도가 넘어가지 않게 한다.
const newStore = async () => {
  // 값 TTL 상한은 주입하지 않고 기본값(정본 1시간)을 쓴다(W7L2-S10)
  const s = createCacheStore({ urls, nodeAddressMap });
  stores.push(s);
  assert.equal(await s.ready(), true, '클러스터에 처음 연결하지 못했다');
  return s;
};

before(async () => {
  for (const n of NAMES) tryDocker('rm', '-f', '-v', n);
  tryDocker('network', 'rm', NET);
  docker('network', 'create', NET);
  for (const name of NAMES) {
    docker('run', '-d', '--name', name, '--hostname', name, '--network', NET, '-p', '127.0.0.1::6379', VALKEY_IMAGE, 'valkey-server',
      '--cluster-enabled', 'yes', '--cluster-config-file', 'nodes.conf', '--cluster-node-timeout', '5000',
      '--cluster-announce-hostname', name, '--cluster-preferred-endpoint-type', 'hostname',
      '--appendonly', 'no', '--save', '', '--protected-mode', 'no');
  }
  for (let i = 0; i < 50 && !NAMES.every((n) => tryDocker('exec', n, 'valkey-cli', 'PING') === 'PONG'); i += 1) await sleep(200);
  const ips = NAMES.map((n) => docker('inspect', '-f', `{{(index .NetworkSettings.Networks "${NET}").IPAddress}}`, n));
  docker('exec', NAMES[0], 'valkey-cli', '--cluster', 'create', ...ips.map((ip) => `${ip}:6379`), '--cluster-replicas', '1', '--cluster-yes');
  let ok = false;
  for (let i = 0; i < 100 && !ok; i += 1) {
    ok = NAMES.every((n) => /cluster_state:ok/.test(tryDocker('exec', n, 'valkey-cli', 'CLUSTER', 'INFO') ?? ''));
    if (!ok) await sleep(300);
  }
  assert.ok(ok, '클러스터가 ok가 되지 않았다');
  for (const n of NAMES) {
    const mapped = docker('port', n, '6379/tcp').split('\n')[0];
    nodeAddressMap[`${n}:6379`] = { host: '127.0.0.1', port: Number(mapped.slice(mapped.lastIndexOf(':') + 1)) };
  }
  urls = [`redis://127.0.0.1:${nodeAddressMap[`${NAMES[0]}:6379`].port}`];
});

after(async () => {
  for (const n of NAMES) tryDocker('unpause', n);
  for (const s of stores) {
    try {
      await s.close?.();
    } catch {
      // 이미 닫혔다
    }
  }
  for (const n of NAMES) tryDocker('rm', '-f', '-v', n);
  tryDocker('network', 'rm', NET);
});

const keys = Array.from({ length: 100 }, (_, i) => `spread-${i}`);

test('HOT-390 W7L2-K1 세 샤드에 흩어진 값 100개를 A가 쓰고 B가 모두 읽는다', async () => {
  // 쓴 키의 슬롯 주인이 세 주 노드 모두 나와야 한다(빈 결과 막기)
  const table = slotTable();
  const owners = new Set(keys.map((k) => ownerOf(`web:data:${k}`, table).master));
  assert.equal(owners.size, 3, `슬롯 주인 ${[...owners].join(', ')}`);
  const a = await newStore();
  const b = await newStore();
  for (const k of keys) await a.setEntry('data', k, `v-${k}`, 3_000);
  let read = 0;
  for (const k of keys) if (String((await b.getEntry('data', k)) ?? '') === `v-${k}`) read += 1;
  assert.equal(read, 100, `B가 ${read}/100개만 읽었다`);
  // 대조군: 노드 하나용 연결(createClient)로는 다른 샤드 키를 읽지 못한다
  const single = createClient({ url: urls[0] });
  await single.connect();
  let singleRead = 0;
  for (const k of keys) {
    try {
      if ((await single.get(`web:data:${k}`)) !== null) singleRead += 1;
    } catch {
      // MOVED
    }
  }
  await single.close();
  assert.ok(singleRead < 100, `노드 하나용 연결이 ${singleRead}개를 읽었다(대조군이 뜻이 없다)`);
});

test('HOT-390 W7L2-K1 태그 무효화가 다른 처리기에 닿고 쓴 키는 모두 TTL이 있다', async () => {
  const table = slotTable();
  const masters = new Set(keys.map((k) => ownerOf(`web:data:${k}`, table).master));
  const hA = createUseCacheHandler({ store: await newStore() });
  const hB = createUseCacheHandler({ store: await newStore() });
  const entry = { value: new Blob(['tagged']).stream(), tags: ['events'], stale: 30, timestamp: Date.now() - 10, expire: 300, revalidate: 60 };
  await hA.set('cluster-tagged', Promise.resolve(entry));
  const got = await hB.get('cluster-tagged', []);
  assert.equal(got ? await new Response(got.value).text() : undefined, 'tagged');
  await sleep(5);
  await hA.updateTags(['events']);
  await hB.refreshTags();
  assert.equal(await hB.get('cluster-tagged', []), undefined, 'A의 태그 무효화가 B에 닿지 않았다');
  // 세 주 노드의 키를 모두 훑어 TTL을 본다
  let seen = 0;
  for (const m of masters) {
    for (const k of cli(m, '--scan').split('\n').filter(Boolean)) {
      seen += 1;
      assert.match(k, /^web:(isr|data|\{tag\}):/, k);
      const ttl = Number(cli(m, 'TTL', k));
      assert.ok(ttl > 0 && ttl <= (k.startsWith('web:{tag}:') ? DAYS_30_S : HOUR_S), `${k}의 TTL ${ttl}`);
    }
  }
  assert.ok(seen > 100, `훑은 키 ${seen}개`);
});

test('HOT-390 W7L2-K2 장애 조치 뒤 다시 쓰기·무효화가 된다', async () => {
  const { replica } = ownerOf('web:{tag}:events');
  const a = await newStore();
  const b = await newStore();
  assert.ok(replica, '태그 키 슬롯의 복제가 없다');
  cli(replica, 'CLUSTER', 'FAILOVER');
  const until = Date.now() + 10_000;
  let seen = 0;
  let at = 0;
  while (Date.now() < until) {
    at = Date.now();
    await a.markTags(['events'], at);
    const t = await b.tagTimes(['events']);
    seen = Number(t?.get?.('events') ?? 0);
    if (seen === at) break;
    await sleep(200);
  }
  assert.equal(seen, at, '장애 조치 뒤 10초 안에 A의 무효화가 B에 보이지 않았다');
  await a.setEntry('data', 'after-failover', 'ok', 300);
  assert.equal(String(await b.getEntry('data', 'after-failover')), 'ok');
});

test('HOT-390 W7L2-K2 멈춘 주 노드에는 명령이 쌓이지 않고 연결을 버린다', async () => {
  const table = slotTable();
  const target = ownerOf(`web:data:${keys[0]}`, table).master;
  const onTarget = keys.filter((k) => ownerOf(`web:data:${k}`, table).master === target);
  const store = await newStore();
  assert.ok(onTarget.length > 0);
  assert.equal(String(await store.getEntry('data', onTarget[0])), `v-${onTarget[0]}`, '멈추기 전 대조군');
  docker('pause', target);
  paused.add(target);
  let maxPending = 0;
  let slowest = 0;
  try {
    for (let batch = 0; batch < 50; batch += 1) {
      await Promise.all(
        Array.from({ length: 10 }, async (_, i) => {
          const t0 = Date.now();
          const p = store.getEntry('data', onTarget[(batch * 10 + i) % onTarget.length]);
          maxPending = Math.max(maxPending, store.stats().pending);
          assert.equal((await p) ?? null, null);
          slowest = Math.max(slowest, Date.now() - t0);
        }),
      );
    }
    assert.ok(slowest <= CMD_LIMIT_MS, `가장 늦은 요청 ${slowest}ms`);
    assert.ok(maxPending <= 50, `쌓인 명령 ${maxPending}`);
    assert.ok(store.stats().resets >= 1, '멈춘 노드 연결을 버리지 않았다');
  } finally {
    docker('unpause', target);
    paused.delete(target);
  }
  // 풀면 회복한다
  const until = Date.now() + 10_000;
  let back = null;
  while (Date.now() < until && back === null) {
    back = (await store.getEntry('data', onTarget[0])) ?? null;
    if (back === null) await sleep(200);
  }
  assert.equal(String(back), `v-${onTarget[0]}`, '풀어도 회복하지 않았다');
});

test('HOT-390 W7L2-K2 클러스터가 내려간 동안 연결 시도가 간격대로만 나간다', async () => {
  const store = await newStore();
  await store.getEntry('data', keys[0]);
  for (const n of NAMES) {
    docker('pause', n);
    paused.add(n);
  }
  try {
    const before = store.stats().connectAttempts;
    const until = Date.now() + 3_000;
    while (Date.now() < until) {
      void store.getEntry('data', keys[Math.floor(Math.random() * keys.length)]);
      await sleep(10);
    }
    const tries = store.stats().connectAttempts - before;
    assert.ok(tries <= 10, `3초 동안 연결 시도 ${tries}번`);
  } finally {
    for (const n of NAMES) {
      tryDocker('unpause', n);
      paused.delete(n);
    }
  }
});
