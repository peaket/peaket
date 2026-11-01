// ST-T18 강제 종료 시험의 소비자 프로세스. 빌드한 플랫폼(dist)을 쓴다(원본 TS는 Node 타입 지우기로 돌지 않는 문법이 있다).
// 인자: <브로커> <PostgreSQL 주소> <그룹> <토픽> <이름> <실행 ID>. 시작하면 'started'를 보낸다. 부모가 SIGKILL로 죽인다.
import pg from 'pg';
import { createDatabase, drizzleHeldEventStore, systemClock } from '../dist/index.js';
import { runKeyedConsumer } from '../dist/stream-worker.js';
import { makeHandler } from './st18-handler.mjs';

const [brokers, url, groupId, topic, member, run] = process.argv.slice(2);
const pool = new pg.Pool({ connectionString: url, max: 8 });
const database = createDatabase({ url, applicationName: `st18-${member}` });
const handler = makeHandler({ pool, run, member, delayMs: 20 });
const c = runKeyedConsumer({
  brokers: brokers.split(','),
  clientId: `st18-${member}`,
  service: 'st18',
  groupId,
  topics: [topic],
  held: drizzleHeldEventStore(database, systemClock),
  handler,
});
await c.started;
process.send?.('started');
setInterval(() => process.send?.({ applied: handler.stats.applied }), 200);
