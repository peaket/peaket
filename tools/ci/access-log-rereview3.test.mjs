// F-01-8 다시 보기 3 재현 시험(2026-11-24). IR-13②·IR-17·IR-22가 다시 열리면 실패한다.
// 설정 글·CLI 동작을 읽어, 시험이 값을 직접 넣는 것이 아니라 생산 경로의 식과 코드가 값을 만드는지 본다.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parse } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

test('IR-13② 법정 seq는 단일 writer 플래그를 켰을 때만 복제 1·RWO PVC·한 자리에 붙는다', () => {
  const chart = parse(read('deploy/charts/peaket-service/values.yaml'));
  const identity = parse(read('deploy/workloads/identity-svc/values.yaml'));
  // 기본 배포는 지금처럼 복제 2이고 플래그는 꺼져 있다
  assert.equal(chart.service.replicas, 2);
  assert.equal(chart.service.legalAccessSeq.enabled, false);
  // identity는 법정 seq를 쓰므로 플래그를 켜고 한 writer만 둔다
  assert.equal(identity.service.legalAccessSeq.enabled, true);
  assert.equal(identity.service.replicas, 1);
  assert.equal(identity.service.persistence.enabled, true);
  const mounts = identity.service.volumeMounts.filter((m) => m.name === 'legal-seq');
  assert.equal(mounts.length, 1, 'legal-seq 마운트는 하나다');
  assert.equal(mounts[0].mountPath, '/var/lib/identity');
  const volumes = identity.service.volumes.filter((v) => v.name === 'legal-seq');
  assert.equal(volumes.length, 1, 'legal-seq 볼륨은 하나다');
  assert.equal(volumes[0].persistentVolumeClaim.claimName, identity.service.persistence.claimName);

  // 템플릿은 플래그가 켜지면 값의 replicas와 무관하게 1로 내리고, 롤링 중 두 파드가 붙지 않게 Recreate다
  const deployment = read('deploy/charts/peaket-service/templates/deployment.yaml');
  assert.match(deployment, /\.Values\.service\.legalAccessSeq\.enabled/);
  assert.match(deployment, /replicas:\s*1/);
  assert.match(deployment, /type:\s*Recreate/);
  assert.match(deployment, /replicas:\s*\{\{ \.Values\.service\.replicas \}\}/);
  const pvc = read('deploy/charts/peaket-service/templates/persistence.yaml');
  assert.match(pvc, /accessModes:\s*\[ReadWriteOnce\]/);
});

test('IR-17 대기열 경로는 수집기가 eventId를 뽑고, 결제 회차는 게이트웨이가 머리에서 옮긴다', () => {
  const collector = read('deploy/platform/observability/collector/access-log.yaml');
  // 생산 경로의 OTTL 식을 그대로 꺼내 표본 경로에 적용한다(시험이 eventId 속성을 직접 넣지 않는다)
  const queueSet = /set\(attributes\["eventId"\], attributes\["path"\]\)\s+where\s+\(attributes\["eventId"\] == nil or attributes\["eventId"\] == ""\)\s+and\s+IsMatch\(attributes\["path"\], "([^"]*v1\/queues\/[^"]*)"\)/.exec(collector);
  assert.ok(queueSet, '대기열 경로에서 eventId를 채우는 식이 없다');
  const queueReplace = /replace_pattern\(attributes\["eventId"\], "(\^\/v1\/queues\/[^"]+)", "\$\$1"\)/.exec(collector);
  assert.ok(queueReplace, '대기열 경로의 회차를 꺼내는 식이 없다');
  const queuePath = '/v1/queues/event-9/entries';
  assert.ok(new RegExp(queueSet[1]).test(queuePath), queueSet[1]);
  assert.equal(queuePath.replace(new RegExp(queueReplace[1]), '$1'), 'event-9');

  // 기존 `/v1/events/{eventId}` 경로도 그대로 뽑는다
  const eventReplace = /replace_pattern\(attributes\["eventId"\], "(\^\/v1\/events\/[^"]+)", "\$\$1"\)/.exec(collector);
  assert.ok(eventReplace, '공연 경로의 회차를 꺼내는 식이 없다');
  assert.equal('/v1/events/event-1/holds'.replace(new RegExp(eventReplace[1]), '$1'), 'event-1');

  // 결제 경로에는 회차가 없으므로 팬 웹이 보내는 머리를 게이트웨이 로그가 eventId 칸으로 옮긴다
  assert.match(read('deploy/gateways/00-common.yaml'), /eventId:\s*"%REQ\(x-peaket-event-id\)%"/);
});

test('IR-24 ORDER·TRANSFER·TICKET_RETURN은 경로에 회차가 없어 생산자가 보낸 eventId 머리를 수집기가 덮어쓰지 않는다', () => {
  const collector = read('deploy/platform/observability/collector/access-log.yaml');
  const gateway = read('deploy/gateways/00-common.yaml');
  // 게이트웨이 로그가 웹이 보낸 머리를 eventId 칸으로 옮긴다
  assert.match(gateway, /eventId:\s*"%REQ\(x-peaket-event-id\)%"/);
  // 수집기의 eventId 경로 추출은 events·queues에만 있다. orders·tickets 경로에는 없어 머리 값을 덮지 않는다
  const pathSets = [...collector.matchAll(/set\(attributes\["eventId"\], attributes\["path"\]\)[^\n]*IsMatch\(attributes\["path"\], "([^"]+)"\)/g)].map((m) => m[1]);
  for (const path of ['/v1/orders', '/v1/orders/order-1/payments', '/v1/tickets/ticket-1/transfers', '/v1/tickets/ticket-1/returns']) {
    assert.ok(!pathSets.some((re) => new RegExp(re).test(path)), `${path} 경로가 eventId를 경로에서 덮어쓴다`);
  }
  // 생산 경로의 보내기 코드가 회차 머리를 싣는다(실제 값은 앱 시험이 fake fetch로 확인한다)
  assert.match(read('apps/web/src/shared/lib/event-id.ts'), /'x-peaket-event-id'/);
  assert.match(read('apps/web/src/_pages/checkout/model/order-send.ts'), /eventIdHeaders\(/);
  assert.match(read('apps/web/src/_pages/ticket-transfer/model/transfer-flow.ts'), /eventIdHeaders\(/);
  assert.match(read('apps/web/src/widgets/ticket-wallet/model/transfer-actions.ts'), /eventIdHeaders\(/);
});

test('IR-22 --anchor도 identity 파드 하나의 빈 seq를 실패로 센다', async () => {
  const server = createServer((req, res) => {
    const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('query') ?? '';
    const data = query.includes("source='gateway'")
      ? [{ n: '2' }]
      : [
          { pod: 'identity-a', n: '3', seqs: [1, 2, 3] },
          { pod: 'identity-b', n: '2', seqs: [1, 3] },
        ];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const cli = join(ROOT, 'tools/local/access-log-jobs.mjs');
  try {
    const child = spawn(
      process.execPath,
      [cli, '--anchor', '--date', '2026-11-24', '--source', '2', '--clickhouse', `http://127.0.0.1:${port}`, '--sha256', 'a'.repeat(64)],
      { cwd: ROOT },
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const code = await new Promise((r) => child.on('close', r));
    assert.equal(code, 1, out);
    const r = JSON.parse(out.trim());
    assert.equal(r.matches, false, out);
    assert.deepEqual(r.identityMissing, [{ pod: 'identity-b', n: 2 }]);
    assert.deepEqual(r.identity.find((p) => p.pod === 'identity-b'), { pod: 'identity-b', missing: [2], duplicates: [] });
  } finally {
    server.close();
  }
});
