// OPS-150 ① 강제 종료 시험의 작업자 프로세스(test-int/batch-worker.int.test.ts). 빌드한 플랫폼(dist)을 쓴다(st18-child.mjs와 같은 까닭).
// 인자: <브로커> <레지스트리 주소> <그룹> <토픽> <읽기 스키마 JSON>. 시작하면 'started'를 보낸다.
// 싱크는 쓰기를 마친 뒤(받은 묶음을 부모에게 알린 뒤) 돌아오지 않는다: 쓰기 뒤·커밋 전에 부모가 SIGKILL로 죽인다.
import { createAvroReader, runBatchWorker, schemaRegistrySource } from '../dist/stream-worker.js';

const [brokers, registryUrl, groupId, topic, readerSchema] = process.argv.slice(2);
const reader = createAvroReader({ source: schemaRegistrySource({ url: registryUrl, env: 'ci' }), readerSchemas: [JSON.parse(readerSchema)] });
const run = runBatchWorker({
  brokers: brokers.split(','),
  worker: 'ops-rt-it',
  env: 'ci',
  pod: 'pod-killed',
  groupId,
  topics: [topic],
  decode: (m) => reader.decode(m.topic, m.value ?? new Uint8Array()),
  sink: {
    table: 'it.orders',
    async write(b) {
      process.send?.({ wrote: { first: b.firstOffset, last: b.lastOffset, offsets: b.records.map((r) => r.offset) } });
      await new Promise(() => {});
    },
  },
  maxRecords: 3,
  maxWaitMs: 200,
});
await run.started;
process.send?.('started');
