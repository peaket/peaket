// ops-svc 시작 조립의 회차 취소 몫(BAT-420 GAT-110 P4). 시험 조립(AppModule에 대역을 넘김)과 따로 시작 파일의 조립을 띄워 본다
// (architecture §8.6 '자주 놓친 결함': 시작 파일 조립은 시험 조립과 따로). 시험 담당이 구현 전에 썼다.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { HttpEventSaleStopper } from '../src/adapters/event-sale-stopper.js';
import { HttpCommandExecutor } from '../src/adapters/http-command-executor.js';
import { HttpCoreEventOwners } from '../src/adapters/http-core-event-owners.js';
import { eventCancellationDepsFromEnv } from '../src/event-cancellation-wiring.js';
import type { EventRefundReader } from '../src/modules/event-cancellations/index.js';
import { DRY_RUN, JOB } from './event-cancellation-fixtures.js';

const executor = new HttpCommandExecutor({});
const reader: EventRefundReader = { preview: async () => DRY_RUN, job: async () => JOB };

describe('ops 시작 조립의 회차 취소 의존 [BAT-420 GAT-110 P4]', () => {
  test('GAT-110 P4 PEAKET_CORE_HTTP_URL이 있을 때만 파트너 소속 확인기를 넣는다', () => {
    expect(eventCancellationDepsFromEnv({ env: {}, executor }).owners).toBeUndefined();
    expect(eventCancellationDepsFromEnv({ env: { PEAKET_CORE_HTTP_URL: '' }, executor }).owners).toBeUndefined();
    expect(eventCancellationDepsFromEnv({ env: { PEAKET_CORE_HTTP_URL: 'http://core-svc:8080' }, executor, internalToken: 'it-token' }).owners).toBeInstanceOf(HttpCoreEventOwners);
  });

  test('GAT-110 P4 판매 중지 집행 길(purchase·queue HTTP 둘 또는 제어 gRPC 둘)이 있을 때만 판매 멈춤을 넣는다', () => {
    const stopperOf = (env: Record<string, string>) => eventCancellationDepsFromEnv({ env, executor }).stopper;
    expect(stopperOf({ PEAKET_PURCHASE_HTTP_URL: 'http://purchase-svc:8080', PEAKET_QUEUE_HTTP_URL: 'http://queue-svc:8080' })).toBeInstanceOf(HttpEventSaleStopper);
    expect(stopperOf({ PEAKET_PURCHASE_CONTROL_GRPC_ADDR: 'purchase-svc:9091', PEAKET_QUEUE_CONTROL_GRPC_ADDR: 'queue-svc:9091' })).toBeInstanceOf(HttpEventSaleStopper);
    expect(stopperOf({})).toBeUndefined();
    expect(stopperOf({ PEAKET_PURCHASE_HTTP_URL: 'http://purchase-svc:8080' })).toBeUndefined();
    expect(stopperOf({ PEAKET_QUEUE_HTTP_URL: 'http://queue-svc:8080' })).toBeUndefined();
    expect(stopperOf({ PEAKET_PURCHASE_CONTROL_GRPC_ADDR: 'purchase-svc:9091' })).toBeUndefined();
  });

  test('GAT-110 P4 purchase gRPC 클라이언트가 있을 때만 미리보기·진행률 읽기를 넣는다', () => {
    expect(eventCancellationDepsFromEnv({ env: {}, executor, refunds: reader }).reader).toBe(reader);
    expect(eventCancellationDepsFromEnv({ env: { PEAKET_PURCHASE_HTTP_URL: 'http://purchase-svc:8080' }, executor }).reader).toBeUndefined();
  });

  test('GAT-110 P4 main.ts는 이 조립을 불러 회차 취소 모듈에 넘긴다', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(main).toContain('eventCancellationDepsFromEnv(');
    expect(main).toMatch(/from '\.\/event-cancellation-wiring\.js'/);
  });
});

// BAT-420 몫 D(OPEN[45] 결정): purchase gRPC 클라이언트(GrpcEventRefunds)가 SetEventRefundHold도 하므로 미룸 대역으로도 넣는다. 시험 담당이 구현 전에 썼다.
describe('ops 시작 조립의 미룸 [BAT-420 몫 D]', () => {
  test('GAT-110 P4 purchase gRPC 클라이언트가 있으면 미룸(holds)으로도 넣고 없으면 비운다', () => {
    const client = { ...reader, hold: async (q: { held: boolean }) => ({ held: q.held }) };
    expect(eventCancellationDepsFromEnv({ env: {}, executor, refunds: client }).holds).toBe(client);
    expect(eventCancellationDepsFromEnv({ env: {}, executor }).holds).toBeUndefined();
  });

  test('GAT-110 P4 main.ts는 조립한 미룸을 회차 취소 모듈에 넘긴다', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(main).toMatch(/holds/);
  });
});

// 검증(e2d565c6) 살아남은 M-P4b·M-P4e: 위 두 시험은 main.ts에 이름이 있는지만 봐서, 넘기는 식에서 owners·holds를 빼도 통과했다.
// main.ts의 회차 취소 조립 식(구조 분해부터 eventCancellations 객체까지)을 그대로 떼어 돌려, 모듈에 실리는 값을 본다(시작 파일 조립을 따로)
describe('main.ts 회차 취소 조립 식을 그대로 돌림 [BAT-420 GAT-110 P4]', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const from = main.indexOf('const { holds, ...cancellationDeps } = ');
  const to = main.indexOf('\n};\n', main.indexOf('const eventCancellations = {', from));
  /** main.ts의 그 몇 줄을 바깥 이름(조립 함수·환경·실행기·gRPC 클라이언트·내부 토큰·재인증·지표)만 넣어 돌린다 */
  const build = (env: Record<string, string>, refunds: unknown) =>
    new Function('eventCancellationDepsFromEnv', 'process', 'executor', 'refunds', 'internalToken', 'reauth', 'eventCancellationSignals', `${main.slice(from, to + 3)}\nreturn eventCancellations;`)(
      eventCancellationDepsFromEnv,
      { env },
      executor,
      refunds,
      'it-token',
      undefined,
      { revertFailures: { inc: () => undefined } },
    ) as Record<string, unknown>;

  test('GAT-110 P4 main.ts 조립 식은 core 주소가 있으면 소속 확인기(owners)를, purchase gRPC 클라이언트가 미룸도 하면 holds를 회차 취소 모듈 값에 싣는다', () => {
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const client = { ...reader, hold: async (q: { held: boolean }) => ({ held: q.held }), start: async () => ({ jobId: 'x', state: 'RUNNING' }) };
    const built = build({ PEAKET_CORE_HTTP_URL: 'http://core-svc:8080', PEAKET_PURCHASE_HTTP_URL: 'http://purchase-svc:8080', PEAKET_QUEUE_HTTP_URL: 'http://queue-svc:8080' }, client);
    expect(built.owners).toBeInstanceOf(HttpCoreEventOwners);
    expect(built.holds).toBe(client);
    expect(built.reader).toBe(client);
    expect(built.refunds).toBe(client);
    expect(built.stopper).toBeInstanceOf(HttpEventSaleStopper);
    // 주소가 없으면 그 칸은 비어 그 경로가 503으로 닫힌다(값이 남지 않는다)
    const bare = build({}, undefined);
    expect(bare.owners).toBeUndefined();
    expect(bare.holds).toBeUndefined();
    // 그렇게 만든 값을 AppModule.register에 그대로 넘긴다
    expect(main).toMatch(/AppModule\.register\(\{[\s\S]*?\n\s+eventCancellations,\n[\s\S]*?\}\),\n\}\);/);
  });
});
