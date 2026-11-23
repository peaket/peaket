// 경보 패널 나누기·접기(pages/dashboard/model/alert-groups.ts의 groupAlerts) 시험(F-03-3 T12·T13, 시험 먼저 ADR-0372). 구현 전 트리에는 파일이 없어 가져오기부터 실패한다.
// 정본: docs/features/control-tower.md §8('경보 패널은 맨 위 SEV1 줄과 이 회차 판단·플랫폼·위생·법정 두 묶음', '예산 SEV1이 울리면 같은 회차·여정의 SEV2는 그 SEV1 아래 접힌 줄'),
// C-T32 ②③(SEV1 아래 접힌 줄, 다른 회차의 경보와 위생 경보는 플랫폼·위생·법정), docs/design/d5-screen-blueprint.md §7.2 '경보 억제'(위 상태 바 SEV 수에는 펼쳐 보이는 경보만),
// docs/api/asyncapi.yaml OpsAlert(kind 열거, eventId, foldedUnder), 계획 §4 '콘솔' groupAlerts(alerts, eventId)·1-14.
// 시험이 정한 결과 모양: { event: Row[], platform: Row[], counts: { sev1, sev2, sev3 } }, Row = { alert, folded: OpsAlert[] }. 묶음 안은 SEV 차례(SEV1 먼저).
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('../../../shared/api/live/live.test.resolve.mjs', import.meta.url);
const load = () => import('./alert-groups.ts');

const E = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
const F = '7d3c2b1a-0f9e-4d8c-8b7a-6f5e4d3c2b1a';
let n = 0;
/** asyncapi OpsAlert 모양의 경보 한 건 */
const alert = (o) => ({ alertId: `al-${++n}`, status: 'firing', startsAt: `2026-11-23T11:0${n % 10}:00.000Z`, title: `경보 ${n}`, ...o });
const ids = (rows) => rows.map((r) => r.alert.alertId);

test('F-03-3 T12 C-T32 ②-2 같은 회차·여정의 SEV1 아래 foldedUnder인 SEV2는 접힌 줄로 들어가고 위 상태 바 SEV 수에서 빠진다', async () => {
  const { groupAlerts } = await load();
  const top = alert({ severity: 'SEV1', kind: 'slo', eventId: E, journey: 'payment_confirm' });
  const folded = alert({ severity: 'SEV2', kind: 'cause', eventId: E, journey: 'payment_confirm', foldedUnder: top.alertId, dependency: 'toss' });
  const plain = alert({ severity: 'SEV2', kind: 'flow', eventId: E });
  const g = groupAlerts([folded, plain, top], E);
  assert.deepEqual(ids(g.event), [top.alertId, plain.alertId]);
  assert.deepEqual(
    g.event[0].folded.map((a) => a.alertId),
    [folded.alertId],
  );
  assert.deepEqual(g.event[1].folded, []);
  assert.deepEqual(g.counts, { sev1: 1, sev2: 1, sev3: 0 });
});

test('F-03-3 T12 C-T32 ②-3 위 경보가 풀리거나 목록에 없으면 접혔던 경보가 펼쳐져 제 묶음에 보이고 SEV 수에 든다', async () => {
  const { groupAlerts } = await load();
  const top = alert({ severity: 'SEV1', kind: 'slo', eventId: E, journey: 'hold' });
  const child = alert({ severity: 'SEV2', kind: 'cause', eventId: E, journey: 'hold', foldedUnder: top.alertId });
  const resolvedTop = { ...top, status: 'resolved', endsAt: '2026-11-23T11:20:00.000Z' };
  const g = groupAlerts([resolvedTop, child], E);
  assert.ok(ids(g.event).includes(child.alertId), '위 경보가 풀렸는데 접힌 경보가 펼쳐지지 않았다');
  assert.equal(g.counts.sev2, 1);
  assert.equal(g.counts.sev1, 0, '풀린 경보를 SEV 수에 셌다');
  const orphan = groupAlerts([child], E);
  assert.deepEqual(ids(orphan.event), [child.alertId]);
  assert.equal(orphan.counts.sev2, 1);
});

test('F-03-3 T13 C-T32 ③-1 고른 회차의 경보는 이 회차 판단, 다른 회차·회차 밖 경보와 위생·법정 종류는 플랫폼·위생·법정이고 묶음 안은 SEV 차례다', async () => {
  const { groupAlerts } = await load();
  const mineSev2 = alert({ severity: 'SEV2', kind: 'control', eventId: E });
  const mineSev1 = alert({ severity: 'SEV1', kind: 'invariant', eventId: E });
  const otherEvent = alert({ severity: 'SEV1', kind: 'slo', eventId: F });
  const noEvent = alert({ severity: 'SEV3', kind: 'change' });
  const hygiene = alert({ severity: 'SEV3', kind: 'hygiene', eventId: E });
  const legal = alert({ severity: 'SEV2', kind: 'legal', eventId: E });
  const all = [mineSev2, otherEvent, noEvent, hygiene, legal, mineSev1];
  const g = groupAlerts(all, E);
  assert.deepEqual(ids(g.event), [mineSev1.alertId, mineSev2.alertId]);
  assert.deepEqual([...ids(g.platform)].sort(), [otherEvent.alertId, noEvent.alertId, hygiene.alertId, legal.alertId].sort());
  const sevOrder = g.platform.map((r) => r.alert.severity);
  assert.deepEqual(sevOrder, [...sevOrder].sort());
  // 회차를 바꾸면 다시 나뉜다
  const h = groupAlerts(all, F);
  assert.deepEqual(ids(h.event), [otherEvent.alertId]);
  assert.ok(ids(h.platform).includes(mineSev1.alertId));
  // 고른 회차가 없으면 모두 플랫폼 쪽이다
  assert.deepEqual(groupAlerts(all, null).event, []);
});

test('F-03-3 T13 C-T32 ③-2 위 상태 바 SEV 수는 걸린 경보만 세고 묶음과 상관없이 모두 센다(풀린 경보는 목록에는 남아도 세지 않는다)', async () => {
  const { groupAlerts } = await load();
  const list = [
    alert({ severity: 'SEV1', kind: 'slo', eventId: F }),
    alert({ severity: 'SEV2', kind: 'control', eventId: E }),
    alert({ severity: 'SEV3', kind: 'hygiene' }),
    alert({ severity: 'SEV3', kind: 'hygiene', status: 'resolved', endsAt: '2026-11-23T11:30:00.000Z' }),
  ];
  const g = groupAlerts(list, E);
  assert.deepEqual(g.counts, { sev1: 1, sev2: 1, sev3: 1 });
  assert.equal(g.event.length + g.platform.length, 4);
});
