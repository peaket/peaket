// SCR-031 감사 로그·인시던트 리플레이의 모델 시험(F-03-7 T1·T2·T3·T5, FR-031, C-T8, 시험 먼저).
// 정본: docs/design/d5-screen-blueprint.md §7.4(행 칸·체인 변조·공개 타임스탬프 대기·공개 앵커 지연),
// docs/features/control-tower.md §7(감사 원본·체크포인트·공개 앵커), openapi CommandState·AuditCheckpoint·AuditCheckpointVerification.
// 시간 경계는 양쪽을 본다(6시간 게시 지연 0ms·1ms 뒤). 구현 전 트리에는 model/audit.ts가 없어 가져오기부터 실패한다.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { E, C1, C2, commandState, dryRunKillSwitch } from '../../commands/model/commands.test.fakes.mjs';

register('../../dashboard/ui/board.test.resolve.mjs', import.meta.url);

const load = () => import('./audit.ts');
const AT = '2026-11-23T11:00:00.000Z';
const AT_MS = Date.parse(AT);
const HOUR = 60 * 60_000;

/** openapi AuditCheckpoint */
function checkpoint(over = {}) {
  return {
    checkpointId: '8d1b2c3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
    fromSeq: 1,
    toSeq: 100,
    rootHash: 'a'.repeat(64),
    prevCheckpointHash: '',
    reason: '일 체크포인트',
    actorRef: 'actor-1',
    createdAt: AT,
    signature: 'sig',
    keyId: 'local:key',
    anchorRef: 'transparency/v1/checkpoints/0000000001.json',
    anchoredAt: AT,
    no: 1,
    kind: 'DAILY',
    leafCount: 100,
    merkleRoot: 'a'.repeat(64),
    checkpointHash: 'b'.repeat(64),
    signatureAlg: 'ECDSA_P256_SHA256',
    otsState: 'COMPLETE',
    publishedAt: AT,
    legacy: false,
    ...over,
  };
}

test('F-03-7 T1 FR-031-1 명령 원장 행이 감사 행 일곱 칸(시각·행위자·명령·사유·승인자·dry-run·결과)으로 바뀐다', async () => {
  const { auditRowOf } = await load();
  const row = auditRowOf(
    commandState({
      type: 'KILL_SWITCH',
      state: 'ACKED',
      reason: '결제사 승인 지연으로 판매를 멈춥니다',
      requestedBy: { adminAccountId: 'acc-1', displayName: '수진', role: 'commander' },
      approvals: ['acc-2'],
      dryRun: dryRunKillSwitch(),
      createdAt: '2026-11-23T11:00:00.000Z',
      executedAt: '2026-11-23T11:00:02.000Z',
      ackedAt: '2026-11-23T11:00:03.000Z',
    }),
  );
  assert.equal(row.at, '2026-11-23T11:00:03.000Z', 'ack가 있으면 그 시각이 행 시각이다');
  assert.equal(row.actor, '수진');
  assert.equal(row.actorRole, 'commander');
  assert.equal(row.typeLabel, '판매 일시정지');
  assert.equal(row.reason, '결제사 승인 지연으로 판매를 멈춥니다');
  assert.equal(row.approver, 'acc-2');
  assert.equal(row.result, '적용 확인');
  assert.equal(row.dryRun.approval, 'none');
  assert.equal(row.dryRun.reauth, true);
  assert.equal(row.dryRun.counted, 1);
  assert.equal(row.dryRun.predicted, 0);
  assert.equal(row.dryRun.unavailable, 1);
});

test('F-03-7 T1 FR-031-2 행위자 없는 자동 만료는 SYSTEM, 승인자·dry-run이 없으면 —와 빈 요약으로 둔다', async () => {
  const { auditRowOf } = await load();
  const row = auditRowOf(commandState({ state: 'AUTO_EXPIRED', requestedBy: undefined, approvals: [], dryRun: null, ackedAt: null, executedAt: '2026-11-23T11:20:00.000Z' }));
  assert.equal(row.actor, '시스템');
  assert.equal(row.actorRole, 'SYSTEM');
  assert.equal(row.approver, '—');
  assert.equal(row.result, '자동 만료');
  assert.equal(row.dryRun.approval, 'unknown');
  assert.equal(row.dryRun.counted, 0);
  assert.equal(row.at, '2026-11-23T11:20:00.000Z');
});

test('F-03-7 T1 FR-031-3 행 거르기는 기간·행위자·종류·검색(명령 ID·사유·회차)으로 하고, 검색은 대소문자를 가리지 않는다', async () => {
  const { auditRowOf, filterAuditRows } = await load();
  const rows = [
    auditRowOf(commandState({ commandId: C1, type: 'KILL_SWITCH', state: 'ACKED', reason: '결제사 지연', createdAt: '2026-11-23T11:00:00.000Z', ackedAt: '2026-11-23T11:00:03.000Z' })),
    auditRowOf(commandState({ commandId: C2, type: 'AUTOMATION_STOP', state: 'AUTO_EXPIRED', reason: '자동 정지 만료', createdAt: '2026-11-23T09:00:00.000Z', ackedAt: '2026-11-23T09:00:02.000Z', requestedBy: undefined })),
    auditRowOf(commandState({ commandId: 'b'.repeat(36), type: 'ADMISSION_TARGET', state: 'ACKED', reason: '목표 올리기', createdAt: '2026-11-22T11:00:00.000Z', ackedAt: '2026-11-22T11:00:02.000Z' })),
  ];
  assert.equal(filterAuditRows(rows, { fromMs: AT_MS - 4 * HOUR }).length, 2);
  assert.deepEqual(filterAuditRows(rows, { actor: 'SYSTEM' }).map((r) => r.commandId), [C2]);
  assert.equal(filterAuditRows(rows, { actor: 'HUMAN' }).length, 2);
  assert.deepEqual(filterAuditRows(rows, { type: 'ADMISSION_TARGET' }).map((r) => r.commandId), ['b'.repeat(36)]);
  assert.deepEqual(filterAuditRows(rows, { query: '결제사' }).map((r) => r.commandId), [C1]);
  assert.deepEqual(filterAuditRows(rows, { query: E.toUpperCase() }).length, 3);
});

test('F-03-7 T2 FR-031-4 체크포인트가 없으면 기록 없음, 검증 실패면 체인 변조(보안 사고 안내), 서명 전이면 대기다', async () => {
  const { chainViewOf } = await load();
  const empty = chainViewOf([], {}, AT_MS);
  assert.equal(empty.kind, 'empty');
  assert.match(empty.message, /체크포인트/);

  const cp = checkpoint();
  const broken = chainViewOf([cp], { [cp.checkpointId]: { valid: false } }, AT_MS);
  assert.equal(broken.kind, 'broken');
  assert.match(broken.message, /감사 체인 검증에 실패/);
  assert.match(broken.message, /보안 사고/);

  const press = checkpoint({ signature: null, publishedAt: null, anchorRef: null, otsState: null });
  assert.equal(chainViewOf([press], {}, AT_MS).kind, 'pending');
});

test('F-03-7 T2 FR-031-5 공개 앵커 게시가 6시간 0ms까지는 검증됨, 1ms 뒤는 게시 지연(SEV3)이다', async () => {
  const { chainViewOf, ANCHOR_LATE_MS } = await load();
  assert.equal(ANCHOR_LATE_MS, 6 * HOUR, '정본 d5 §7.4의 6시간');
  const cp = checkpoint({ publishedAt: new Date(AT_MS - 6 * HOUR).toISOString() });
  const at = chainViewOf([cp], {}, AT_MS);
  assert.equal(at.kind, 'verified');
  assert.equal(at.anchor, 'none');
  const late = chainViewOf([cp], {}, AT_MS + 1);
  assert.equal(late.kind, 'late');
  assert.equal(late.anchor, 'late');
  assert.match(late.message, /게시/);
});

test('F-03-7 T2 FR-031-6 공개 타임스탬프가 대기면 확정 대기 띠이고, 완료면 띠가 없다', async () => {
  const { chainViewOf } = await load();
  const pending = chainViewOf([checkpoint({ otsState: 'PENDING' })], {}, AT_MS);
  assert.equal(pending.anchor, 'pending');
  assert.match(pending.message, /비트코인 확정 전|확정 대기/);
  const done = chainViewOf([checkpoint({ otsState: 'COMPLETE' })], {}, AT_MS);
  assert.equal(done.anchor, 'none');
  assert.equal(done.lastNo, 1);
});

test('F-03-7 T3 FR-031-7 리플레이는 명령 접수·ack·되돌림·체크포인트를 시간순으로 놓고, 재생 위치가 경계 양쪽에서 맞는다', async () => {
  const { auditRowOf, replayTimelineOf, replayAt } = await load();
  const rows = [
    auditRowOf(
      commandState({
        state: 'REVERTED',
        reason: '재개',
        createdAt: '2026-11-23T11:00:00.000Z',
        executedAt: '2026-11-23T11:05:00.000Z',
        ackedAt: '2026-11-23T11:00:03.000Z',
      }),
    ),
  ];
  const timeline = replayTimelineOf(rows, [checkpoint({ createdAt: '2026-11-23T11:04:00.000Z' })]);
  assert.deepEqual(
    timeline.map((e) => e.kind),
    ['REQUEST', 'ACK', 'CHECKPOINT', 'REVERT'],
  );
  const start = replayAt(timeline, Date.parse('2026-11-23T11:00:00.000Z'));
  assert.equal(start.done, 1);
  assert.equal(start.index, 0);
  const beforeAck = replayAt(timeline, Date.parse('2026-11-23T11:00:02.999Z'));
  assert.equal(beforeAck.done, 1, 'ack 1ms 전에는 접수만 지나갔다');
  const afterAck = replayAt(timeline, Date.parse('2026-11-23T11:00:03.000Z'));
  assert.equal(afterAck.done, 2, 'ack 0ms에는 ack가 포함된다');
  const empty = replayAt([], AT_MS);
  assert.equal(empty.index, -1);
  assert.equal(empty.done, 0);
});

test('F-03-7 T4 C-T39-1 검증 묶음은 commander·데스크톱/태블릿만 열리고, 원본 로그 내보내기는 원천이 없어 늘 막힌다', async () => {
  const { exportAvailability } = await load();
  assert.deepEqual(exportAvailability({ role: 'commander', layout: 'desktop' }), { bundle: true, raw: false, reason: '원본 로그 내보내기 경로가 아직 서버에 없습니다(원천 연결 전)' });
  assert.equal(exportAvailability({ role: 'commander', layout: 'tablet' }).bundle, true);
  const op = exportAvailability({ role: 'operator', layout: 'desktop' });
  assert.equal(op.bundle, false);
  assert.match(op.reason, /commander/);
  assert.equal(exportAvailability({ role: 'commander', layout: 'phone' }).bundle, false);
  assert.match(exportAvailability({ role: 'commander', layout: 'phone' }).reason, /태블릿이나 데스크톱/);
});

test('F-03-7 T5 C-T8 되돌린 명령은 결과가 되돌림이고, 리플레이에 실행·ack·되돌림 사건이 남는다(승인 전에는 되돌림 사건이 없다)', async () => {
  const { auditRowOf, auditRowsOf, replayTimelineOf } = await load();
  const acked = commandState({ state: 'ACKED', createdAt: AT, ackedAt: '2026-11-23T11:00:03.000Z' });
  const reverted = commandState({ state: 'REVERTED', createdAt: AT, ackedAt: '2026-11-23T11:00:03.000Z', executedAt: '2026-11-23T11:07:00.000Z' });
  assert.equal(auditRowsOf([acked]).length, 1, 'ACKED는 실행 줄 하나다');
  const rows = auditRowsOf([reverted]);
  assert.equal(rows.length, 1, '한 명령은 한 행이고, 되돌림은 그 행의 결과로 남는다');
  assert.equal(rows[0].result, '되돌림');
  const events = replayTimelineOf([auditRowOf(reverted)], []);
  assert.deepEqual(events.map((e) => e.kind), ['REQUEST', 'ACK', 'REVERT'], '리플레이에는 접수·ack·되돌림 세 사건이 남는다');
});
