// 로컬 브라우저 확인용 준비(docs/features/seat-hold.md §14 '로컬 실행'). 빌드한 dist/를 쓴다(pnpm build 뒤).
// 1) 마이그레이션 2) 대기열·좌석 열기와 등급별 가격 넣기(docs/features/payment.md §13 동작 4) 3) 시험 계정을 대기열에 넣고 입장시킨다
// (v0 모놀리스 HTTP에 신원 머리를 직접 실어 부른다). v0 모놀리스는 결제사로 PG 시뮬레이터(PEAKET_V0_PG_URL·PG_SIMULATOR_SECRET_KEY)를 쓴다.
// 쓰는 법(로컬 Valkey·PostgreSQL 컨테이너와 v0 모놀리스가 떠 있어야 한다):
//   PEAKET_ENV=local PEAKET_V0_REDIS_URL=redis://127.0.0.1:6379 PEAKET_V0_DATABASE_URL=postgres://… V0_UPSTREAM=http://127.0.0.1:8080 \
//   node scripts/local-demo.mjs demo-1 user1,user2
import { createDatabase } from '@peaket/platform';
import { createBookingAdmin } from '../dist/modules/booking/index.js';
import { createSeatAdmin, seatGrid } from '../dist/modules/inventory/index.js';
import { createQueueAdmin } from '../dist/modules/queue/index.js';
import { createV0Redis } from '../dist/redis.js';
import { identityHeaders } from './local-gateway.mjs';
import { migrateV0 } from './migrate.mjs';

if (process.env.PEAKET_ENV !== 'local') throw new Error('준비 스크립트는 PEAKET_ENV=local에서만 돈다');
const eventId = process.argv[2] ?? 'demo-1';
const names = (process.argv[3] ?? 'user1,user2').split(',').filter(Boolean);
const need = (/** @type {string} */ k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k}이 없다`);
  return v;
};
const upstream = process.env.V0_UPSTREAM ?? 'http://127.0.0.1:8080';

await migrateV0(need('PEAKET_V0_DATABASE_URL'));
const redis = await createV0Redis(need('PEAKET_V0_REDIS_URL'));
const database = createDatabase({ url: need('PEAKET_V0_DATABASE_URL'), applicationName: 'v0-local-demo' });
try {
  await createQueueAdmin(redis).open(eventId, { admitPerSecond: 1000 });
  // 구역 다섯 × 20열 × 40석 = 4,000석(등급 셋)
  const seats = seatGrid({ sections: ['A', 'B', 'C', 'D', 'E'], rows: 20, perRow: 40, grades: { A: 'S', B: 'R', C: 'VIP', D: 'R', E: 'S' } });
  await createSeatAdmin(database).open(eventId, { perPersonLimit: 4 }, seats);
  await createBookingAdmin(database).setPrices(eventId, { VIP: 170000, R: 150000, S: 130000 });
  for (const name of names) {
    const r = await fetch(`${upstream}/v1/queues/${eventId}/entries`, { method: 'POST', headers: identityHeaders(name) });
    if (r.status !== 201 && r.status !== 409) throw new Error(`진입 ${name}: ${r.status}`);
  }
  // 입장 루프(v0 모놀리스가 0.25초마다 돈다)가 부를 때까지 기다린 뒤 입장 확정
  for (const name of names) {
    let admitted = false;
    for (let i = 0; i < 40 && !admitted; i += 1) {
      const r = await fetch(`${upstream}/v1/queues/${eventId}/admission`, { method: 'POST', headers: identityHeaders(name) });
      const body = /** @type {{ status?: string }} */ (await r.json());
      admitted = r.status === 200 && body.status === 'ADMITTED';
      if (!admitted) await new Promise((ok) => setTimeout(ok, 250));
    }
    if (!admitted) throw new Error(`시험 계정 ${name}이 10초 안에 입장하지 못했다(v0 모놀리스의 입장 루프가 도는지 본다)`);
  }
  console.log(`준비 끝: 회차 ${eventId}, 좌석 ${seats.length}석, 입장한 시험 계정 ${names.join(', ')}`);
} finally {
  await redis.close();
  await database.close();
}
