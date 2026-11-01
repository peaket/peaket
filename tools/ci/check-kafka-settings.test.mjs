// check-kafka-settings.mjs를 바깥에서 돌려 보는 시험(D-T45 ①~⑥, docs/devops.md, ADR-0142 결정 3). 실행: node --test "tools/ci/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './git-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'check-kafka-settings.mjs');
const repoRoot = join(here, '..', '..');

function run(files) {
  const root = tempDir('kafka-settings-');
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['add', '-A'], { cwd: root });
  return spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
}

const use = (extra) => `import { createKafkaProducer } from '@peaket/platform/stream-worker';\nexport const p = createKafkaProducer({ brokers: [], clientId: 'x', kind: 'default', extra: ${extra} });\n`;

test('저장소는 통과한다', () => {
  const r = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('D_T45_⑥_공용모듈기본값그대로인판은_통과한다', () => {
  const r = run({
    'services/purchase-svc/src/kafka.ts': use(`{ 'linger.ms': 5 }`),
    // Kafka를 쓰지 않는 파일의 같은 이름 칸은 상관없다(제어 명령의 ack 수 등)
    'services/ops-svc/src/ack.ts': 'export const card = { acks: 3, sessionTimeout: 10 };\n',
  });
  assert.equal(r.status, 0, r.stderr);
});

for (const [label, extra, name] of [
  ['①', `{ acks: 1 }`, 'acks'],
  ['①', `{ 'enable.idempotence': false }`, 'enable.idempotence'],
  ['①', `{ idempotent: false }`, 'idempotent'],
  ['②', `{ 'max.in.flight.requests.per.connection': 6 }`, 'max.in.flight.requests.per.connection'],
  ['②', `{ partitioner: 'consistent_random' }`, 'partitioner'],
  ['③', `{ "message.timeout.ms": 30000 }`, 'message.timeout.ms'],
  ['④', `{ 'enable.auto.commit': true }`, 'enable.auto.commit'],
  ['④', `{ 'partition.assignment.strategy': 'range' }`, 'partition.assignment.strategy'],
  ['④', `{ 'group.protocol': 'consumer' }`, 'group.protocol'],
  ['④', `{ 'session.timeout.ms': 10000 }`, 'session.timeout.ms'],
  ['④', `{ autoCommit: true }`, 'autoCommit'],
  ['⑤', `{ 'group.instance.id': 'pod-1' }`, 'group.instance.id'],
]) {
  test(`D_T45_${label}_${name}를 덮어쓴 판은 실패한다`, () => {
    const r = run({ 'services/purchase-svc/src/kafka.ts': use(extra) });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, new RegExp(name.replace(/\./g, '\\.')));
    assert.match(r.stderr, /services\/purchase-svc\/src\/kafka\.ts:2/);
  });
}

test('D_T45_Kafka클라이언트를직접가져오면_실패한다(필수 설정을 거치지 않는다)', () => {
  const r = run({
    'services/a/src/x.ts': "import { KafkaJS } from '@confluentinc/kafka-javascript';\n",
    'services/b/src/y.js': "const { Kafka } = require('kafkajs');\n",
    'apps/web/src/z.ts': "const k = await import('@confluentinc/kafka-javascript');\n",
    // 다른 librdkafka 감싸기도 같다(코드 리뷰 2026-11-01)
    'services/c/src/w.ts': "import Kafka from 'node-rdkafka';\n",
  });
  assert.equal(r.status, 1);
  for (const f of ['services/a/src/x.ts', 'services/b/src/y.js', 'apps/web/src/z.ts', 'services/c/src/w.ts']) assert.match(r.stderr, new RegExp(f.replace(/\//g, '\\/').replace(/\./g, '\\.')));
});

test('공용 모듈 폴더와 시험 파일은 보지 않는다', () => {
  const r = run({
    'packages/platform/src/stream-worker/kafka.ts': "import { KafkaJS } from '@confluentinc/kafka-javascript';\nexport const c = { acks: 'all' };\n",
    'packages/platform/src/kafka-config.ts': "export const c = { 'enable.auto.commit': false, kafkaProducerConfig: 1 };\n",
    'services/a/test/kafka.test.ts': use(`{ acks: 1 }`),
    'services/a/src/kafka.int.test.ts': use(`{ acks: 1 }`),
  });
  assert.equal(r.status, 0, r.stderr);
});

test('검사 목록은 공용 설정 함수의 금지 목록과 같다(그룹 이름만 뺀다)', () => {
  const pick = (text, name) => [...new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(text)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const platform = readFileSync(join(repoRoot, 'packages/platform/src/kafka-config.ts'), 'utf8');
  const fromPlatform = [...pick(platform, 'KAFKA_PRODUCER_LOCKED'), ...pick(platform, 'KAFKA_CONSUMER_LOCKED')].filter((n) => n !== 'group.id' && n !== 'groupId');
  const fromScript = [.../const LOCKED = \[([^\]]*)\]/.exec(readFileSync(script, 'utf8'))[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...fromScript].sort(), [...fromPlatform].sort());
});
