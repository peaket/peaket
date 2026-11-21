// 운영 사건 줄 ops_event를 실제 서비스 로거 출력(붙잡는 Writable)과 모듈 공개 면(OpsEventStore·OpsEventLog)으로 본다(BAT-360 OPS-290, ADR-0349 결정 8, 계획 6절 B23).
// 정본 값(docs/observability.md '운영 사건 줄', ADR-0349 결정 8): 명령 사건이 커밋된 뒤 표본 없이 한 줄, 칸은 opsEvent(`<번호>:<유형>`, 카탈로그 밖 `-:<유형>`)·stage·eventId·actorRole
// (operator·commander·SYSTEM)·commandId, 사람 이름·계정·가명 참조는 싣지 않는다. 명령 2 만료는 10분(SAFETY_LIMITS 정본 control-tower §3).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createService, fakeClock } from '@peaket/platform';
import { afterEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { UnavailableAdminIdentity } from '../src/modules/admin-accounts/index.js';
import { COMMAND_STORE, MaintainCommands, MemoryCommandStore, OpsEventLog, OpsEventStore, type CommandExecutor, type OpsEventLine } from '../src/modules/commands/index.js';
import { reauthKit } from './admin-support.js';
import { FakeIdentity } from './support.js';

const NOW = Date.parse('2026-11-23T04:00:00.000Z');
const MIN = 60_000;
const PAUSE_MS = 10 * MIN;

/** 서비스 로그 줄을 모은다 */
function capture(): { stream: Writable; lines: () => Record<string, unknown>[]; raw: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write: (c: Buffer | string, _e, cb) => {
      chunks.push(c.toString());
      cb();
    },
  });
  const raw = () => chunks.join('');
  const lines = () =>
    raw()
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { stream, lines, raw };
}

const opened: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const s of opened.splice(0)) await s.close();
});

async function harness() {
  const clock = fakeClock({ now: NOW });
  const identity = new FakeIdentity();
  const log = capture();
  const kit = reauthKit(() => clock.now());
  const executor: CommandExecutor = { execute: async () => ({ status: 'ACKED', ackedAtMs: clock.now() }) };
  const svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({ memory: true, executor, auditChain: new MemoryAuditChain(), adminAccounts: { identity: new UnavailableAdminIdentity(), reauth: kit.verifier } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: log.stream,
    adminAuthz: identity,
  });
  opened.push(svc);
  const found: unknown = svc.app.get(COMMAND_STORE);
  if (!(found instanceof MemoryCommandStore)) throw new Error('메모리 조립의 명령 저장소가 아니다');
  return {
    svc,
    clock,
    identity,
    log,
    store: found,
    maintain: svc.app.get(MaintainCommands),
    withToken: (who: Record<string, string>) => ({ ...who, 'x-reauth-token': kit.token({ accountId: who['x-user-id']!, sessionId: who['x-session-id']!, act: 'OPS_COMMAND' }) }),
    post: (url: string, who: Record<string, string>, body: unknown) =>
      svc.http.inject({ method: 'POST', url, headers: { ...(url === '/v1/ops/commands' ? { 'idempotency-key': randomUUID() } : {}), ...who, 'content-type': 'application/json' }, payload: JSON.stringify(body) }),
  };
}

const opsEvents = (lines: Record<string, unknown>[], commandId?: string) => lines.filter((l) => l.kind === 'ops_event' && (commandId === undefined || l.commandId === commandId));

describe('C-T45 ① 운영 사건 줄(ADR-0349 결정 8, B23)', () => {
  test('C-T45 ① 명령 2 요청부터 만료까지 ops_event가 단계마다 하나, 계정 없음', async () => {
    const h = await harness();
    const op = h.identity.ops('operator');
    const eventId = randomUUID();
    const r = await h.post('/v1/ops/commands', op, { type: 'ADMISSION_PAUSE', reason: '입장 일시정지', params: { eventId } });
    expect(r.statusCode, r.payload).toBe(201);
    const commandId = (JSON.parse(r.payload) as { commandId: string; state: string }).commandId;
    expect((JSON.parse(r.payload) as { state: string }).state).toBe('ACKED');
    // 10분 만료 − 1ms에는 만료 줄이 없다
    h.clock.advance(PAUSE_MS - 1);
    await h.maintain.runOnce(h.clock.now());
    expect(opsEvents(h.log.lines(), commandId).map((l) => l.stage)).not.toContain('AUTO_EXPIRED');
    h.clock.advance(1);
    await h.maintain.runOnce(h.clock.now());
    await h.maintain.runOnce(h.clock.now() + 1);
    const mine = opsEvents(h.log.lines(), commandId);
    expect(mine.map((l) => l.stage)).toEqual(['REQUESTED', 'APPROVED', 'ACKED', 'AUTO_EXPIRED']);
    for (const l of mine) expect(l).toMatchObject({ kind: 'ops_event', opsEvent: '2:ADMISSION_PAUSE', eventId, commandId });
    expect(mine.map((l) => l.actorRole)).toEqual(['operator', 'operator', 'SYSTEM', 'SYSTEM']);
  });

  test('[ASVS v5.0.0-16.2.4] 줄은 공통 JSON 한 줄이고 명령 ID·회차 ID·`<번호>:<유형>`·단계·역할로 감사 기록과 잇는다(카탈로그 밖은 `-:<유형>`, 회차가 없으면 null)', async () => {
    const h = await harness();
    const commander = h.identity.ops('commander');
    const op = h.identity.ops('operator');
    const log = await h.post('/v1/ops/commands', op, { type: 'LOG_LEVEL', reason: '로그 단계', params: { level: 'DEBUG' } });
    const logId = (JSON.parse(log.payload) as { commandId: string }).commandId;
    expect(opsEvents(h.log.lines(), logId)[0]).toMatchObject({ opsEvent: '8:LOG_LEVEL', stage: 'REQUESTED', eventId: null, actorRole: 'operator', commandId: logId });
    const scale = await h.post('/v1/ops/commands', commander, { type: 'SCALE_CHANGE', reason: '규모 변경', params: { eventId: randomUUID(), scale: 'LARGE' } });
    expect(scale.statusCode, scale.payload).toBe(201);
    const scaleId = (JSON.parse(scale.payload) as { commandId: string }).commandId;
    expect(opsEvents(h.log.lines(), scaleId)[0]).toMatchObject({ opsEvent: '-:SCALE_CHANGE', stage: 'REQUESTED', actorRole: 'commander' });
    // 감사 기록의 대상(recordId)과 같은 명령 ID로 잇는다
    for (const l of opsEvents(h.log.lines())) expect(l.commandId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('[ASVS v5.0.0-16.2.5] 요청자·승인자의 관리 계정 ID·세션·가명 참조는 ops_event 줄 어디에도 없다(M4)', async () => {
    const h = await harness();
    const requester = h.identity.ops('operator');
    const commander = h.identity.ops('commander');
    const approver = h.identity.ops('commander');
    const pause = await h.post('/v1/ops/commands', requester, { type: 'ADMISSION_PAUSE', reason: '입장 일시정지', params: { eventId: randomUUID() } });
    const pauseId = (JSON.parse(pause.payload) as { commandId: string }).commandId;
    const stop = await h.post('/v1/ops/commands', h.withToken(commander), { type: 'SALE_STOP', reason: '판매 중지', params: { eventId: randomUUID(), reasonCode: 'LEGAL_REQUEST' } });
    expect(stop.statusCode, stop.payload).toBe(201);
    const stopId = (JSON.parse(stop.payload) as { commandId: string }).commandId;
    expect((await h.post(`/v1/ops/commands/${stopId}/approvals`, h.withToken(approver), {})).statusCode).toBe(200);
    h.clock.advance(PAUSE_MS);
    await h.maintain.runOnce(h.clock.now());
    const mine = [...opsEvents(h.log.lines(), pauseId), ...opsEvents(h.log.lines(), stopId)];
    // 승인자 줄(2인 승인의 APPROVED)과 시스템 줄(ACKED·AUTO_EXPIRED)이 모두 들어 있어야 빈 결과로 통과하지 않는다
    expect(opsEvents(h.log.lines(), stopId).map((l) => [l.stage, l.actorRole])).toEqual(expect.arrayContaining([['REQUESTED', 'commander'], ['APPROVED', 'commander']]));
    expect(opsEvents(h.log.lines(), pauseId).map((l) => l.stage)).toEqual(expect.arrayContaining(['REQUESTED', 'ACKED', 'AUTO_EXPIRED']));
    const text = JSON.stringify(mine);
    const secrets = [
      ...[requester, commander, approver].flatMap((w) => [w['x-user-id']!, w['x-session-id']!]),
      ...h.store.actors().filter((a) => a.commandId === pauseId || a.commandId === stopId).map((a) => a.actorRef),
    ];
    expect(secrets.length).toBeGreaterThanOrEqual(8);
    for (const s of secrets) expect(text).not.toContain(s);
    // 줄에는 계정·이름 칸이 없다
    for (const l of mine) {
      for (const k of ['accountId', 'adminAccountId', 'actorRef', 'approverRef', 'requestedBy', 'displayName']) expect(l[k]).toBeUndefined();
    }
  });

  test('C-T45 ① 되돌아간 쓰기는 줄을 남기지 않고 커밋된 쓰기만 남긴다(모듈 공개 면)', async () => {
    const lines: OpsEventLine[] = [];
    const inner = new MemoryCommandStore(new MemoryAuditChain());
    const store = new OpsEventStore(inner, new OpsEventLog((l) => lines.push(l)));
    const eventId = randomUUID();
    const { command } = await store.insert({
      commandId: randomUUID(),
      type: 'ADMISSION_PAUSE',
      reason: '일시정지',
      params: { eventId },
      eventId,
      requestedBy: randomUUID(),
      requestedRole: 'operator',
      nowMs: NOW,
      dryRun: {},
      approvalMode: 'ONE',
    });
    const before = lines.length;
    expect(lines.map((l) => l.stage)).toContain('REQUESTED');
    await expect(
      store.mutate(command.commandId, async (w) => {
        await w.event({ type: 'ACKED', actorRef: '00000000-0000-0000-0000-000000000000', actorRole: 'system', reason: '시험', nowMs: NOW });
        throw new Error('되돌림');
      }),
    ).rejects.toThrow('되돌림');
    expect(lines.length).toBe(before);
    await store.mutate(command.commandId, async (w) => {
      await w.event({ type: 'REJECTED', actorRef: '00000000-0000-0000-0000-000000000000', actorRole: 'system', reason: '시험', nowMs: NOW });
    });
    expect(lines.slice(before)).toEqual([{ opsEvent: '2:ADMISSION_PAUSE', stage: 'REJECTED', eventId, actorRole: 'SYSTEM', commandId: command.commandId }]);
  });
});
