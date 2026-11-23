// 명령 1·3·6 작성 값 → 접수 본문, 화면 막힘, 멱등 키 묶음(F-03-4 T3·T7·T8, 시험 먼저 ADR 0372번).
// 정본: docs/api/openapi.yaml Command(type·reason·params)와 Command.params 설명(ADMISSION_TARGET {eventId, target, fromTarget},
// KILL_SWITCH {scope, eventIds}, DEGRADED_MODE 결제 갈래 {mode: PAYMENT_PG_FALLBACK, scope, eventIds, toPg}), IdempotencyKey(따옴표 없는 UUID v4),
// docs/features/control-tower.md §3 표(필수 권한·승인 요건), §12 '휴대폰·태블릿', docs/design/d5-screen-blueprint.md §7.3 CMP-036 disabled 글,
// 계획 docs/review/plans/F-03-4.md §4 command-form.ts·6-2·6-3.
// 구현 전 트리에는 model/command-form.ts가 없어 시험마다 가져오기부터 실패한다(시험마다 따로 가져온다).
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { E } from './commands.test.fakes.mjs';

register('../../dashboard/ui/board.test.resolve.mjs', import.meta.url);

const load = () => import('./command-form.ts');
const OPENAPI = readFileSync(new URL('../../../../../../docs/api/openapi.yaml', import.meta.url), 'utf8');
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** openapi Command.params 설명에서 그 유형의 칸 이름 목록({…} 안의 이름) */
function contractFields(marker) {
  const at = OPENAPI.indexOf(marker);
  assert.ok(at > 0, `openapi Command.params 설명에 '${marker}'가 없다`);
  const open = OPENAPI.indexOf('{', at);
  let depth = 0;
  let end = open;
  for (; end < OPENAPI.length; end += 1) {
    if (OPENAPI[end] === '(') depth += 1;
    if (OPENAPI[end] === ')') depth -= 1;
    if (OPENAPI[end] === '}' && depth === 0) break;
  }
  return OPENAPI.slice(open + 1, end)
    .replace(/\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '')
    .split(',')
    .map((s) => s.trim().split(/[\s:(]/)[0])
    .filter(Boolean);
}

test('F-03-4 T3 ①-1 명령 1 본문은 openapi ADMISSION_TARGET 칸(eventId·target·fromTarget)만 싣고, 사유는 앞뒤 공백만 지운다', async () => {
  const { commandBodyOf } = await load();
  const allowed = contractFields('ADMISSION_TARGET {eventId');
  assert.deepEqual(allowed, ['eventId', 'target', 'fromTarget']);
  const body = commandBodyOf({ kind: 'ADMISSION_TARGET', eventId: E, target: 5200, fromTarget: 4000, reason: '  결제 대기 줄이  기  ' });
  assert.deepStrictEqual(body, { type: 'ADMISSION_TARGET', reason: '결제 대기 줄이  기', params: { eventId: E, target: 5200, fromTarget: 4000 } });
  // 지금 목표를 모르면 fromTarget 칸을 싣지 않는다(빈 값·null을 싣지 않는다)
  const bare = commandBodyOf({ kind: 'ADMISSION_TARGET', eventId: E, target: 1000, reason: '목표 낮추기' });
  assert.deepStrictEqual(bare, { type: 'ADMISSION_TARGET', reason: '목표 낮추기', params: { eventId: E, target: 1000 } });
  for (const b of [body, bare]) for (const k of Object.keys(b.params)) assert.ok(allowed.includes(k), `계약에 없는 칸 ${k}`);
});

test('F-03-4 T3 ①-2 명령 3 본문은 이 회차면 eventIds: [회차], 전체면 eventIds 칸 없이 scope만 싣는다', async () => {
  const { commandBodyOf } = await load();
  assert.ok(OPENAPI.includes('KILL_SWITCH {scope, eventIds}'), 'openapi KILL_SWITCH 칸 설명이 바뀌었다');
  assert.deepStrictEqual(commandBodyOf({ kind: 'KILL_SWITCH', scope: 'EVENT', eventId: E, reason: '결제사 장애' }), {
    type: 'KILL_SWITCH',
    reason: '결제사 장애',
    params: { scope: 'EVENT', eventIds: [E] },
  });
  const platform = commandBodyOf({ kind: 'KILL_SWITCH', scope: 'PLATFORM', eventId: E, reason: '전체 멈춤' });
  assert.deepStrictEqual(platform, { type: 'KILL_SWITCH', reason: '전체 멈춤', params: { scope: 'PLATFORM' } });
  assert.equal(Object.hasOwn(platform.params, 'eventIds'), false);
});

test('F-03-4 T3 ①-3 명령 6 결제 갈래 본문은 DEGRADED_MODE {mode: PAYMENT_PG_FALLBACK, scope, eventIds, toPg?}이고 toPg가 없으면 칸도 없다', async () => {
  const { commandBodyOf } = await load();
  const allowed = contractFields('DEGRADED_MODE의 결제 갈래 {mode');
  assert.deepEqual(allowed, ['mode', 'scope', 'eventIds', 'toPg']);
  const event = commandBodyOf({ kind: 'PG_FALLBACK', scope: 'EVENT', eventId: E, toPg: 'PORTONE', reason: '토스 승인 지연' });
  assert.deepStrictEqual(event, { type: 'DEGRADED_MODE', reason: '토스 승인 지연', params: { mode: 'PAYMENT_PG_FALLBACK', scope: 'EVENT', eventIds: [E], toPg: 'PORTONE' } });
  const platform = commandBodyOf({ kind: 'PG_FALLBACK', scope: 'PLATFORM', reason: '전체 전환' });
  assert.deepStrictEqual(platform, { type: 'DEGRADED_MODE', reason: '전체 전환', params: { mode: 'PAYMENT_PG_FALLBACK', scope: 'PLATFORM' } });
  for (const b of [event, platform]) for (const k of Object.keys(b.params)) assert.ok(allowed.includes(k), `계약에 없는 칸 ${k}`);
});

test('F-03-4 T3 ①-4 칸이 모자라면(사유 빔·공백뿐, 회차 없음, 목표가 수가 아님) 본문을 만들지 않고 null이다', async () => {
  const { commandBodyOf } = await load();
  assert.equal(commandBodyOf({ kind: 'ADMISSION_TARGET', eventId: E, target: 5200, reason: '' }), null);
  assert.equal(commandBodyOf({ kind: 'ADMISSION_TARGET', eventId: E, target: 5200, reason: ' \n\t ' }), null);
  assert.equal(commandBodyOf({ kind: 'ADMISSION_TARGET', eventId: '', target: 5200, reason: '사유' }), null);
  assert.equal(commandBodyOf({ kind: 'ADMISSION_TARGET', eventId: E, target: Number.NaN, reason: '사유' }), null);
  assert.equal(commandBodyOf({ kind: 'KILL_SWITCH', scope: 'EVENT', reason: '회차 없음' }), null);
  assert.equal(commandBodyOf({ kind: 'PG_FALLBACK', scope: 'EVENT', reason: '회차 없음' }), null);
  assert.equal(commandBodyOf({ kind: 'KILL_SWITCH', scope: 'PLATFORM', reason: '   ' }), null);
  // 경계 반대쪽: 한 글자 사유는 본문이 된다(길이·범위 검사의 정본은 서버, ADR-0340 결정 10)
  assert.deepStrictEqual(commandBodyOf({ kind: 'KILL_SWITCH', scope: 'PLATFORM', reason: ' 가 ' }), { type: 'KILL_SWITCH', reason: '가', params: { scope: 'PLATFORM' } });
});

test('F-03-4 T7 ①-1 제출 하나(Submission)는 UUID v4 멱등 키 하나를 끝까지 같은 값으로 갖고, 새 제출은 새 키다', async () => {
  const { Submission } = await load();
  const a = new Submission();
  const b = new Submission();
  assert.match(a.idempotencyKey, UUID_V4);
  assert.match(b.idempotencyKey, UUID_V4);
  assert.equal(a.idempotencyKey, a.idempotencyKey);
  assert.notEqual(a.idempotencyKey, b.idempotencyKey);
  // 따옴표 없는 꼴(openapi IdempotencyKey)
  assert.equal(a.idempotencyKey.includes('"'), false);
});

test('F-03-4 T8 C-T46 ③-1 화면 막힘: 명령 1은 operator 이상, 명령 3·6 요청은 commander만, viewer는 모두 막히고 까닭 글이 있다', async () => {
  const { commandAvailability } = await load();
  for (const role of ['operator', 'commander']) assert.deepEqual(commandAvailability({ role, layout: 'desktop', kind: 'ADMISSION_TARGET' }), { canRequest: true });
  assert.deepEqual(commandAvailability({ role: 'commander', layout: 'desktop', kind: 'KILL_SWITCH' }), { canRequest: true });
  assert.deepEqual(commandAvailability({ role: 'commander', layout: 'desktop', kind: 'PG_FALLBACK' }), { canRequest: true });
  // d5 §7.3 CMP-036 disabled 글 그대로
  assert.deepEqual(commandAvailability({ role: 'operator', layout: 'desktop', kind: 'KILL_SWITCH' }), { canRequest: false, reason: '판매 일시정지는 commander만 실행할 수 있습니다' });
  const pg = commandAvailability({ role: 'operator', layout: 'desktop', kind: 'PG_FALLBACK' });
  assert.equal(pg.canRequest, false);
  assert.match(pg.reason, /^대체 결제사 전환은 commander만 .+ 수 있습니다$/);
  for (const kind of ['ADMISSION_TARGET', 'KILL_SWITCH', 'PG_FALLBACK']) {
    const v = commandAvailability({ role: 'viewer', layout: 'desktop', kind });
    assert.equal(v.canRequest, false, `viewer ${kind}`);
    assert.equal(typeof v.reason, 'string');
    assert.ok(v.reason.length > 0);
  }
  assert.match(commandAvailability({ role: 'viewer', layout: 'desktop', kind: 'ADMISSION_TARGET' }).reason, /operator/);
});

test('F-03-4 T8 C-T46 ③-2 휴대폰 배치는 commander라도 명령 1·3·6 요청이 막히고, 태블릿은 막지 않는다(control-tower §12)', async () => {
  const { commandAvailability } = await load();
  for (const kind of ['ADMISSION_TARGET', 'KILL_SWITCH', 'PG_FALLBACK']) {
    assert.deepEqual(commandAvailability({ role: 'commander', layout: 'phone', kind }), { canRequest: false, reason: '명령 요청과 실행은 태블릿이나 데스크톱에서 합니다' }, kind);
    assert.deepEqual(commandAvailability({ role: 'commander', layout: 'tablet', kind }), { canRequest: true }, kind);
  }
});
