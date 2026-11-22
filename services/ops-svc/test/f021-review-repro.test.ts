// F-02-1 리뷰 반영 재현(계획 15절 막는 지적 RV-01·RV-04·RV-06, '리뷰 반영' 소절의 감독 결정).
// - RV-01: 명령 7(LOBBY_BANNER)은 승인된 템플릿만 받는다. 승인 템플릿 저장소가 없는 지금은 만들기·미리보기가 422 invalid-command이고
//   명령·사건·감사가 남지 않으며, 제어 종류 바꾸기가 템플릿 ID를 banner 글로 싣지 않는다(ADR-0365 결정 2 '바꿈', docs/data.md notice banner = 공지 글).
// - RV-04: 카탈로그 명령의 처음 실행은 접수·승인 응답이 DISPATCHED로 바로 오고, 퍼뜨리기·ack는 응답 밖(배경)이다(ADR-0365 결정 4).
//   부름마다의 데드라인 1초는 test-int/f021-review-deadline.int.test.ts가 실제 gRPC로 본다.
// - RV-06: 판매 중지·재개는 응답 안에서 기다리되 시한은 명령 하나에 하나 = 처음 보낸 때 + 10초와 요청 남은 시간(x-peaket-deadline-ms) 가운데 짧은 쪽이다.
//   받는 쪽 하나가 답하지 않으면 그 시한에 FAILED(ack-timeout:<서비스>)로 끝난다. 시각은 서비스 가짜 시계 하나를 퍼뜨리기의 대기가 민다.
// 받는 쪽은 ControlTransport 포트 대역, 대상 찾기는 ControlTargets 대역, 저장소는 HTTP 앱의 메모리 저장소다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createService, fakeClock, type FakeClock } from '@peaket/platform';
import { afterEach, describe, expect, test } from 'vitest';
import { HttpCommandExecutor } from '../src/adapters/http-command-executor.js';
import { AppModule } from '../src/app.module.js';
import { UnavailableAdminIdentity } from '../src/modules/admin-accounts/index.js';
import { type Command, ControlFanout, type ControlTargets, type ControlTransport, MemoryControlDeliveries, controlDeliveriesOf } from '../src/modules/commands/index.js';
import { fakeReauth, tokenFor } from './event-cancellation-fixtures.js';
import { FakeIdentity, quiet } from './support.js';

const NOW = Date.parse('2026-11-23T05:00:00.000Z');
const ACK_TIMEOUT_MS = 10_000;
type ControlRequest = Parameters<ControlTransport['apply']>[2];

const identity = new FakeIdentity();
let svc: Awaited<ReturnType<typeof createService>> | undefined;
afterEach(async () => {
  await svc?.close();
  svc = undefined;
});

interface Wiring {
  readonly clock: FakeClock;
  readonly sent: { service: string; at: number; req: ControlRequest }[];
}
/** HTTP 앱 하나. answer가 정한 대로 받는 쪽이 답한다. background면 카탈로그 명령의 퍼뜨리기를 모듈에 잇고, saleStop이면 판매 중지 실행기에 잇는다 */
async function app(o: { answer: (service: string, req: ControlRequest, at: number) => Promise<number>; background?: boolean; saleStop?: boolean }): Promise<Wiring> {
  const clock = fakeClock({ now: NOW });
  const sent: Wiring['sent'] = [];
  const targets: ControlTargets = { resolve: async (service: string) => [`10.7.0.1:${service.length}`] };
  const transport: ControlTransport = {
    apply: async (service: string, _address: string, req: ControlRequest) => {
      const at = clock.now();
      sent.push({ service, at, req });
      return { appliedVersion: await o.answer(service, req, at), podName: `${service}-0` };
    },
  };
  const fanout = new ControlFanout({ targets, transport, deliveries: new MemoryControlDeliveries(), clock, sleep: async (ms: number) => clock.advance(ms) });
  const executor = o.saleStop ? new HttpCommandExecutor({ controlDelivery: fanout, nowMs: () => clock.now() }) : undefined;
  svc = await createService({
    name: 'ops-svc',
    module: AppModule.register({
      memory: true,
      ...(executor ? { executor } : {}),
      nowMs: NOW,
      adminAccounts: { identity: new UnavailableAdminIdentity(), reauth: fakeReauth() },
      ...(o.background ? { commandExtras: { control: { fanout, clock } } } : {}),
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
  return { clock, sent };
}
const withReauth = (h: Record<string, string>) => ({ ...h, 'x-reauth-token': tokenFor(h['x-user-id']!, { act: 'OPS_COMMAND' }) });
const post = (url: string, headers: Record<string, string>, body: unknown) =>
  svc!.http.inject({ method: 'POST', url, headers: { ...withReauth(headers), ...(url === '/v1/ops/commands' ? { 'idempotency-key': randomUUID() } : {}), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const get = (url: string, headers: Record<string, string>) => svc!.http.inject({ method: 'GET', url, headers });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;

describe('RV-01 명령 7은 승인 템플릿만 (ADR-0365 결정 2 바꿈)', () => {
  test('RV-01 ① 승인 템플릿이 없으면 명령 7 만들기는 422 invalid-command(detail templateId)이고 명령이 남지 않는다. 미리보기도 같은 422다', async () => {
    await app({ answer: async (_s, req) => req.version, background: true });
    const commander = identity.ops('commander');
    const body = { type: 'LOBBY_BANNER', reason: '입장 지연 안내', params: { eventId: randomUUID(), templateId: 'entry-delay' } };
    const created = await post('/v1/ops/commands', commander, body);
    expect(created.statusCode, created.payload).toBe(422);
    expect(json(created)).toMatchObject({ type: expect.stringMatching(/invalid-command$/), status: 422 });
    expect(created.payload).toContain('templateId');
    const list = await get('/v1/ops/commands?type=LOBBY_BANNER', commander);
    expect(list.statusCode).toBe(200);
    expect((json(list).items as unknown[]).length, '거절했는데 명령이 남았다').toBe(0);
    const preview = await post('/v1/ops/command-dry-runs', commander, body);
    expect(preview.statusCode, preview.payload).toBe(422);
    expect(json(preview)).toMatchObject({ type: expect.stringMatching(/invalid-command$/), status: 422 });
  });

  test('RV-01 ② 명령 7의 바라는 상태에 템플릿 ID 글이 실리지 않는다(받는 쪽 notice banner에 ID가 서지 않게)', () => {
    const command: Pick<Command, 'type' | 'params'> = { type: 'LOBBY_BANNER', params: { eventId: randomUUID(), templateId: 'entry-delay' } };
    const sentText = (() => {
      try {
        return JSON.stringify(controlDeliveriesOf(command, 'APPLY', { sentAtMs: NOW }));
      } catch {
        return 'rejected';
      }
    })();
    expect(sentText).not.toContain('entry-delay');
  });
});

describe('RV-04 처음 실행은 응답 밖 (ADR-0365 결정 4)', () => {
  test('RV-04 ② 명령 3을 접수하면 받는 쪽이 답하기 전에 응답이 DISPATCHED로 오고, 받는 쪽이 답한 뒤에야 ACKED다', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const w = await app({ answer: async (_s, req) => (await gate, req.version), background: true });
    const commander = identity.ops('commander');
    const r = await post('/v1/ops/commands', commander, { type: 'KILL_SWITCH', reason: '판매 긴급 정지', params: { scope: 'EVENT', eventIds: [randomUUID()] } });
    expect(r.statusCode, r.payload).toBe(201);
    const { commandId, state } = json(r) as { commandId: string; state: string };
    expect(state).toBe('DISPATCHED');
    expect((json(await get(`/v1/ops/commands/${commandId}`, commander)) as { state: string }).state).toBe('DISPATCHED');
    expect(w.sent.length, '응답 전에 받는 쪽을 부르기 시작했어야 한다(배경)').toBeGreaterThanOrEqual(1);
    release();
    await expect.poll(async () => (json(await get(`/v1/ops/commands/${commandId}`, commander)) as { state: string }).state, { timeout: 5_000, interval: 20 }).toBe('ACKED');
  });
});

describe('RV-06 응답 안 기다림의 시한은 명령 하나에 하나 (ASVS v5.0.0-15.1.3)', () => {
  const saleStop = async (w: Wiring, headers: Record<string, string> = {}) => {
    const requester = identity.ops('commander');
    const approver = identity.ops('commander');
    const created = await post('/v1/ops/commands', requester, { type: 'SALE_STOP', reason: '판매자 신원 확인', params: { eventId: randomUUID(), reasonCode: 'SELLER_IDENTITY' } });
    expect(created.statusCode, created.payload).toBe(201);
    const { commandId } = json(created) as { commandId: string };
    const startedAt = w.clock.now();
    const approved = await post(`/v1/ops/commands/${commandId}/approvals`, { ...approver, ...headers }, {});
    return { approved, elapsedMs: w.clock.now() - startedAt, detail: json(await get(`/v1/ops/commands/${commandId}`, approver)) as { state: string; lastError?: string | null } };
  };

  test('RV-06 ① purchase-svc가 9초에 답하고 queue-svc가 답하지 않으면 두 서비스 합쳐 처음 보낸 때 + 10초 안에 FAILED ack-timeout:queue-svc로 끝난다', async () => {
    let first: number | undefined;
    const w = await app({
      saleStop: true,
      answer: async (service, req, at) => {
        first ??= at;
        if (service === 'purchase-svc') return at - first >= 9_000 ? req.version : req.version - 1;
        return req.version - 1;
      },
    });
    const r = await saleStop(w);
    expect(r.elapsedMs, `응답 안에서 ${r.elapsedMs}ms 기다렸다`).toBeLessThanOrEqual(ACK_TIMEOUT_MS);
    expect(r.detail).toMatchObject({ state: 'FAILED', lastError: 'ack-timeout:queue-svc' });
  });

  test('RV-06 ② 요청 남은 시간이 3초면 queue-svc가 답하지 않아도 응답이 3초 + 다시 보내기 한 번(1초) 안에 끝나고 FAILED ack-timeout:queue-svc다', async () => {
    const w = await app({ saleStop: true, answer: async (service, req) => (service === 'purchase-svc' ? req.version : req.version - 1) });
    const r = await saleStop(w, { 'x-peaket-deadline-ms': '3000' });
    expect(r.elapsedMs, `남은 시간 3초 요청이 ${r.elapsedMs}ms 기다렸다`).toBeLessThanOrEqual(3_000 + 1_000);
    expect(r.detail).toMatchObject({ state: 'FAILED', lastError: 'ack-timeout:queue-svc' });
  });
});
