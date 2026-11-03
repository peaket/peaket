#!/usr/bin/env node
// D-T45 Kafka 클라이언트 필수 설정 정적 검사(docs/devops.md D-T45, ADR-0142 결정 3, docs/streaming.md §2.6,
// openspec 변경 add-maintenance-control-and-consumers 결정 2). 서비스·작업자·Outbox 릴레이의 Kafka 클라이언트는 공용 모듈
// (@peaket/platform의 kafka-config.ts·stream-worker)이 필수 값으로 만든다. 다음을 막는다.
//  ① Kafka 클라이언트 패키지(@confluentinc/kafka-javascript, kafkajs, node-rdkafka)를 공용 모듈 밖에서 가져오는 것(필수 설정을 거치지 않는다)
//  ② 공용 모듈을 쓰는 파일에서 필수 설정 이름을 객체 키로 쓰는 것(acks, enable.idempotence, max.in.flight…, partitioner,
//     message.timeout.ms, enable.auto.commit, partition.assignment.strategy, session.timeout.ms, group.protocol, group.instance.id와
//     KafkaJS 호환 별칭). 공용 모듈의 설정 함수도 실행 때 같은 이름을 거절한다
// 보는 곳: git이 추적하는 apps/·services/·packages/의 TypeScript·JavaScript. 공용 모듈 파일과 시험 파일은 뺀다.
// 쓰는 법: node tools/ci/check-kafka-settings.mjs [--root .]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { root: { type: 'string', default: '.' } } });
const root = values.root;

// packages/platform/src/kafka-config.ts의 KAFKA_PRODUCER_LOCKED·KAFKA_CONSUMER_LOCKED에서 그룹 이름(group.id·groupId)만 뺀 것이다
// (그룹 이름은 설정 함수의 필수 인자라 키로 쓴다. 덧붙일 설정에 넣으면 설정 함수가 거절한다). 시험이 두 목록을 맞춰 본다
const LOCKED = [
  'acks',
  'request.required.acks',
  'enable.idempotence',
  'idempotent',
  'max.in.flight.requests.per.connection',
  'max.in.flight',
  'maxInFlightRequests',
  'partitioner',
  'createPartitioner',
  'message.timeout.ms',
  'delivery.timeout.ms',
  'enable.auto.commit',
  'autoCommit',
  'partition.assignment.strategy',
  'partitionAssigners',
  'partitionAssignors',
  'session.timeout.ms',
  'sessionTimeout',
  'group.protocol',
  'group.instance.id',
  'groupInstanceId',
];
const CLIENTS = ['@confluentinc/kafka-javascript', 'kafkajs', 'node-rdkafka'];
const ALLOWED = [/^packages\/platform\/src\/kafka-config\.ts$/, /^packages\/platform\/src\/stream-worker(\/|\.ts$)/];
const TEST = /(^|\/)(test|test-int|__tests__)\/|\.(test|spec|int\.test)\.[cm]?[jt]sx?$/;
const SOURCE = /\.[cm]?[jt]sx?$/;
// 공용 모듈을 쓰는 표시: 하위 내보내기 가져오기나 설정 함수 이름
const USES_PLATFORM_KAFKA = /@peaket\/platform\/stream-worker|\bkafka(Producer|Consumer)Config\b|\bcreateKafka(Producer|Consumer|Admin)?\b/;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const keyPattern = new RegExp(`(?:^|[{,\\s])(?:(['"\`])(${LOCKED.map(esc).join('|')})\\1|(${LOCKED.filter((n) => !n.includes('.')).map(esc).join('|')}))\\s*:`, 'g');
const importPattern = new RegExp(`(?:from\\s*|import\\s*\\(\\s*|require\\s*\\(\\s*|import\\s+)(['"\`])(${CLIENTS.map(esc).join('|')})(?:/[^'"\`]*)?\\1`, 'g');

function tracked() {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', 'apps', 'services', 'packages'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return out.split('\0').filter((p) => p && SOURCE.test(p) && !p.split('/').includes('node_modules'));
}

const errors = [];
for (const rel of tracked()) {
  if (TEST.test(rel) || ALLOWED.some((re) => re.test(rel))) continue;
  let text;
  try {
    text = readFileSync(join(root, rel), 'utf8');
  } catch {
    continue;
  }
  const lines = text.split('\n');
  const usesPlatform = USES_PLATFORM_KAFKA.test(text);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(importPattern)) errors.push(`${rel}:${i + 1}: Kafka 클라이언트 ${m[2]}를 직접 가져온다. @peaket/platform/stream-worker를 쓴다(D-T45 ①)`);
    if (!usesPlatform) return;
    for (const m of line.matchAll(keyPattern)) errors.push(`${rel}:${i + 1}: Kafka 필수 설정 ${m[2] ?? m[3]}를 덮어쓴다(D-T45, docs/streaming.md §2.6)`);
  });
}

if (errors.length > 0) {
  for (const e of errors) console.error(e);
  console.error(`Kafka 필수 설정 검사 실패 ${errors.length}건(ADR-0142 결정 3)`);
  process.exit(1);
}
console.log('Kafka 필수 설정 검사 통과');
