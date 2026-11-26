// Q-T59 ⑥ 예매 제한 집행 gRPC의 부르는 쪽 허용 목록(시험 담당, 2026-11-26, F-06-4).
// 정본: docs/features/queue-admission.md §6 '예매 제한 확인'(부르는 쪽은 ops-svc뿐), docs/architecture.md §5 '포트별 허용 표', ADR-0285.
// 집행 자리는 메시 L7 허용 목록이다(queue-svc·purchase-svc 처리기는 신원을 보지 않는다). 그 밖 신원은 PERMISSION_DENIED다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const allow = parse(readFileSync(join(REPO, 'deploy', 'platform', 'mesh', 'port-allow.yaml'), 'utf8'));

const allowed = (workload, service) => allow.workloads[workload]?.ports?.grpc?.services?.[service];

test('Q-T59 ⑥ queue-svc·purchase-svc BookingRestrictionService를 부를 수 있는 신원은 ops-svc 하나다', () => {
  assert.deepEqual(allowed('queue-svc', 'peaket.queue.v1.BookingRestrictionService'), ['ops-svc']);
  assert.deepEqual(allowed('purchase-svc', 'peaket.purchase.v1.BookingRestrictionService'), ['ops-svc']);
  for (const other of ['gw-fan', 'gw-queue', 'purchase-svc', 'core-svc', 'ticket-svc', 'trust-svc', 'ops-breakglass']) {
    assert.equal(allowed('queue-svc', 'peaket.queue.v1.BookingRestrictionService').includes(other), false, `queue-svc: ${other}`);
    assert.equal(allowed('purchase-svc', 'peaket.purchase.v1.BookingRestrictionService').includes(other), false, `purchase-svc: ${other}`);
  }
});
