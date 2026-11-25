// SCR-030 나머지 운영 명령(2·4·5·8·9·11·12)의 본문·막힘 시험(F-03-7 T15·T16, 시험 먼저).
// 정본: docs/api/openapi.yaml Command.params 설명(ADMISSION_PAUSE {eventId}, BLOCK_ASN_IP {cidrs, asns, expiresAt}, BOT_LEVEL {level, reassessMode}, PG_ASSIGN {eventId, primaryPg, fallbackPg}),
// docs/features/control-tower.md §3 표(권한·승인·안전 범위)·§12 휴대폰(11만 허용), docs/design/d5-screen-blueprint.md §7.3.
// 구현 전 트리에는 새 명령 갈래가 없어 본문이 null이 되거나 가져오기부터 실패한다.
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { E } from './commands.test.fakes.mjs';

register('../../dashboard/ui/board.test.resolve.mjs', import.meta.url);

const load = () => import('./command-form.ts');

test('F-03-7 T15-1 명령 2는 ADMISSION_PAUSE {eventId}만 싣고, 회차가 없으면 null이다', async () => {
  const { commandBodyOf } = await load();
  assert.deepStrictEqual(commandBodyOf({ kind: 'ADMISSION_PAUSE', eventId: E, reason: ' 잠시 멈춤 ' }), { type: 'ADMISSION_PAUSE', reason: '잠시 멈춤', params: { eventId: E } });
  assert.equal(commandBodyOf({ kind: 'ADMISSION_PAUSE', eventId: '', reason: '사유' }), null);
  assert.equal(commandBodyOf({ kind: 'ADMISSION_PAUSE', eventId: E, reason: '  ' }), null);
});

test('F-03-7 T15-2 명령 4는 CIDR·ASN을 나눠 싣고 만료가 필수이며, 한 목록도 없으면 null이다', async () => {
  const { commandBodyOf } = await load();
  const body = commandBodyOf({
    kind: 'BLOCK_ASN_IP',
    cidrsText: '203.0.113.0/24\n198.51.100.0/24, 192.0.2.0/24',
    asnsText: '64500, 64501',
    expiresAt: '2026-11-24T11:00:00.000Z',
    reason: '공격 대역 차단',
  });
  assert.deepStrictEqual(body, {
    type: 'BLOCK_ASN_IP',
    reason: '공격 대역 차단',
    params: { cidrs: ['203.0.113.0/24', '198.51.100.0/24', '192.0.2.0/24'], asns: [64500, 64501], expiresAt: '2026-11-24T11:00:00.000Z' },
  });
  assert.equal(commandBodyOf({ kind: 'BLOCK_ASN_IP', cidrsText: '  ', asnsText: ' ', expiresAt: '2026-11-24T11:00:00.000Z', reason: '사유' }), null);
  assert.equal(commandBodyOf({ kind: 'BLOCK_ASN_IP', cidrsText: '203.0.113.0/24', asnsText: 'abc', expiresAt: '2026-11-24T11:00:00.000Z', reason: '사유' }), null);
  assert.equal(commandBodyOf({ kind: 'BLOCK_ASN_IP', cidrsText: '203.0.113.0/24', asnsText: '64500', expiresAt: '', reason: '사유' }), null);
  assert.equal(commandBodyOf({ kind: 'BLOCK_ASN_IP', cidrsText: '203.0.113.0/24', asnsText: '', expiresAt: '2026-11-24T11:00:00.000Z', reason: '사유' }), null, '한 목록만으로는 서버가 거절한다');
});

test('F-03-7 T15-3 명령 5는 BOT_LEVEL {level, reassessMode?}이고, 재평가 모드는 고를 때만 싣는다', async () => {
  const { commandBodyOf } = await load();
  assert.deepStrictEqual(commandBodyOf({ kind: 'BOT_LEVEL', level: 'AGGRESSIVE', reassessMode: 'SHADOW', reason: '매크로 급증' }), {
    type: 'BOT_LEVEL',
    reason: '매크로 급증',
    params: { level: 'AGGRESSIVE', reassessMode: 'SHADOW' },
  });
  const bare = commandBodyOf({ kind: 'BOT_LEVEL', level: 'STANDARD', reason: '기본으로' });
  assert.deepStrictEqual(bare, { type: 'BOT_LEVEL', reason: '기본으로', params: { level: 'STANDARD' } });
  assert.equal(Object.hasOwn(bare.params, 'reassessMode'), false);
  assert.equal(commandBodyOf({ kind: 'BOT_LEVEL', level: 'EXTREME', reason: '사유' }), null);
});

test('F-03-7 T15-4 명령 8·9는 계약 확정 전 최소 칸(LOG_LEVEL {service, level}, FEATURE_OFF {flag})으로 만들고, 명령 11은 params 없이 보낸다', async () => {
  const { commandBodyOf } = await load();
  assert.deepStrictEqual(commandBodyOf({ kind: 'LOG_LEVEL', service: 'ops-svc', level: 'DEBUG', reason: '원인 확인' }), { type: 'LOG_LEVEL', reason: '원인 확인', params: { service: 'ops-svc', level: 'DEBUG' } });
  assert.equal(commandBodyOf({ kind: 'LOG_LEVEL', service: ' ', level: 'DEBUG', reason: '사유' }), null);
  assert.deepStrictEqual(commandBodyOf({ kind: 'FEATURE_OFF', flag: 'reviews', reason: '장애 격리' }), { type: 'FEATURE_OFF', reason: '장애 격리', params: { flag: 'reviews' } });
  assert.equal(commandBodyOf({ kind: 'FEATURE_OFF', flag: '', reason: '사유' }), null);
  const stop = commandBodyOf({ kind: 'AUTOMATION_STOP', reason: '자동 조절 폭주' });
  assert.deepStrictEqual(stop, { type: 'AUTOMATION_STOP', reason: '자동 조절 폭주' });
  assert.equal(Object.hasOwn(stop, 'params'), false);
});

test('F-03-7 T15-5 명령 12는 PG_ASSIGN {eventId, primaryPg, fallbackPg?}이고 기본·대체가 같으면 null이다', async () => {
  const { commandBodyOf } = await load();
  assert.deepStrictEqual(commandBodyOf({ kind: 'PG_ASSIGN', eventId: E, primaryPg: 'TOSS', fallbackPg: 'PORTONE', reason: '결제사 지정' }), {
    type: 'PG_ASSIGN',
    reason: '결제사 지정',
    params: { eventId: E, primaryPg: 'TOSS', fallbackPg: 'PORTONE' },
  });
  const one = commandBodyOf({ kind: 'PG_ASSIGN', eventId: E, primaryPg: 'PORTONE', reason: '결제사 지정' });
  assert.deepStrictEqual(one, { type: 'PG_ASSIGN', reason: '결제사 지정', params: { eventId: E, primaryPg: 'PORTONE' } });
  assert.equal(Object.hasOwn(one.params, 'fallbackPg'), false);
  assert.equal(commandBodyOf({ kind: 'PG_ASSIGN', eventId: E, primaryPg: 'TOSS', fallbackPg: 'TOSS', reason: '사유' }), null);
  assert.equal(commandBodyOf({ kind: 'PG_ASSIGN', eventId: '', primaryPg: 'TOSS', reason: '사유' }), null);
});

test('F-03-7 T16-1 명령 2·4·5·8·9·12는 operator 이상, 11은 commander만, 휴대폰은 11만 살아 있다', async () => {
  const { commandAvailability } = await load();
  const operatorKinds = ['ADMISSION_PAUSE', 'BLOCK_ASN_IP', 'BOT_LEVEL', 'LOG_LEVEL', 'FEATURE_OFF', 'PG_ASSIGN'];
  for (const kind of operatorKinds) {
    assert.deepEqual(commandAvailability({ role: 'operator', layout: 'desktop', kind }), { canRequest: true }, kind);
    assert.deepEqual(commandAvailability({ role: 'commander', layout: 'tablet', kind }), { canRequest: true }, kind);
    const viewer = commandAvailability({ role: 'viewer', layout: 'desktop', kind });
    assert.equal(viewer.canRequest, false, `viewer ${kind}`);
    assert.ok(viewer.reason.length > 0);
    const phone = commandAvailability({ role: 'commander', layout: 'phone', kind });
    assert.equal(phone.canRequest, false, `phone ${kind}`);
    assert.match(phone.reason, /태블릿이나 데스크톱/);
  }
  assert.deepEqual(commandAvailability({ role: 'commander', layout: 'desktop', kind: 'AUTOMATION_STOP' }), { canRequest: true });
  assert.deepEqual(commandAvailability({ role: 'commander', layout: 'phone', kind: 'AUTOMATION_STOP' }), { canRequest: true }, '휴대폰도 안전 쪽 조치인 11은 낼 수 있다');
  const operator = commandAvailability({ role: 'operator', layout: 'desktop', kind: 'AUTOMATION_STOP' });
  assert.equal(operator.canRequest, false);
  assert.match(operator.reason, /commander/);
});

test('F-03-7 T16-2 명령 7·10은 이 화면의 작성 카드가 아니다(계약·경로가 없다)', async () => {
  const { COMMAND_NAMES } = await load();
  assert.equal(Object.hasOwn(COMMAND_NAMES, 'LOBBY_BANNER'), false);
  assert.equal(Object.hasOwn(COMMAND_NAMES, 'TAKEDOWN'), false);
  assert.ok(Object.hasOwn(COMMAND_NAMES, 'AUTOMATION_STOP'));
  assert.ok(Object.hasOwn(COMMAND_NAMES, 'PG_ASSIGN'));
});
