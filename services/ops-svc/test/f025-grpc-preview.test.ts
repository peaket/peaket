// ops-svc가 실제 gRPC로 PreviewControl을 보내는 길(GrpcControlTransport.preview)을 계약 proto 서버 대역으로 본다
// (F-02-5 OPS-300, TR-02, ADR-0365 결정 11·16, 계획 8.1·8.2, C-T6 ①).
// - proto 칸: scope·kind·keys를 그대로 보내고, counts[{key,value,source,measured_at(Timestamp)}]·unavailable[{key,reason}]·pod_name을 읽는다.
// - Timestamp는 초·나노를 밀리초로 바꾼다(measured_at).
// - 받는 쪽이 gRPC DEADLINE_EXCEEDED(4)로 답하면 어댑터(ControlPreviewDryRunSource)는 receiver-timeout:<서비스>,
//   그 밖의 오류(UNAVAILABLE not-leader 포함)는 receiver-unavailable:<서비스>로 남긴다.
// - 실제 서버는 @grpc/grpc-js + 계약 생성물(controlV1Control)로 띄운다(적용 gRPC와 같은 proto).
import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { controlV1Control } from '@peaket/contracts/proto';
import { afterEach, describe, expect, test } from 'vitest';
import { GrpcControlTransport } from '../src/adapters/grpc-control-sender.js';
import { ControlPreviewDryRunSource, type ControlTargets } from '../src/modules/commands/index.js';

const SCOPE = '0b9a3c4e-5d6f-4a1b-8c2d-3e4f5a6b7c01';
const SERVICE = 'purchase-svc';
const KEYS = ['purchaseSessions', 'paymentSessions'] as const;
const CYCLE = Date.parse('2026-12-05T11:00:00.200Z');
const NOW = CYCLE + 5_000;

type Handler = (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => void;

let loaded: { ControlReceiver: grpc.ServiceClientConstructor } | undefined;
function controlPackage(): { ControlReceiver: grpc.ServiceClientConstructor } {
  if (!loaded) {
    const def = protoLoader.fromJSON(controlV1Control as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
    loaded = (grpc.loadPackageDefinition(def) as unknown as { peaket: { control: { v1: { ControlReceiver: grpc.ServiceClientConstructor } } } }).peaket.control.v1;
  }
  return loaded;
}

const servers: grpc.Server[] = [];
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    await new Promise<void>((r) => s.tryShutdown(() => r()));
  }
});

/** 계약 proto로 만든 실제 gRPC 서버. PreviewControl만 시험이 정하고 ApplyControl은 쓰지 않는다 */
async function servePreview(handler: Handler): Promise<{ address: string; calls: Record<string, unknown>[] }> {
  const calls: Record<string, unknown>[] = [];
  const server = new grpc.Server();
  servers.push(server);
  server.addService(controlPackage().ControlReceiver.service, {
    ApplyControl: (_call: unknown, cb: grpc.sendUnaryData<unknown>) => cb(Object.assign(new Error('unused'), { code: grpc.status.UNIMPLEMENTED })),
    PreviewControl: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      calls.push({ ...call.request, keys: [...((call.request.keys as string[] | undefined) ?? [])] });
      handler(call, cb);
    },
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, p) => (err ? reject(err) : resolve(p)));
  });
  server.start();
  return { address: `127.0.0.1:${port}`, calls };
}

const ts = (ms: number): { seconds: number; nanos: number } => ({ seconds: Math.floor(ms / 1_000), nanos: (ms % 1_000) * 1_000_000 });
const targetsOf = (address: string): ControlTargets => ({ resolve: async (service: string) => (service === SERVICE ? [address] : []) });
const salePauseCount = { type: 'KILL_SWITCH' as const, params: { scope: 'EVENT', eventIds: [SCOPE] }, eventId: SCOPE };

const unavailableReason = async (r: Awaited<ReturnType<ControlPreviewDryRunSource['count']>>) => Object.fromEntries(r.unavailable.map((u) => [u.key, u.reason]));

describe('TR-02 실제 gRPC PreviewControl 전송(계약 proto)', () => {
  test('TR-02 ① scope·kind·keys를 그대로 보내고 counts의 measured_at Timestamp를 밀리초로, unavailable·pod_name을 그대로 읽는다', async () => {
    const { address, calls } = await servePreview((_call, cb) =>
      cb(null, {
        counts: [
          { key: 'purchaseSessions', value: 912, source: 'seat-redis', measured_at: ts(CYCLE) },
          { key: 'paymentSessions', value: 37, source: 'seat-redis', measured_at: ts(CYCLE) },
        ],
        unavailable: [],
        pod_name: 'purchase-svc-7c9',
      }),
    );
    const transport = new GrpcControlTransport();
    try {
      const r = await transport.preview!(SERVICE, address, { scope: SCOPE, kind: 'CONTROL_KIND_SALE_PAUSE', keys: [...KEYS] });
      expect(r).toEqual({
        counts: [
          { key: 'purchaseSessions', value: 912, source: 'seat-redis', measuredAtMs: CYCLE },
          { key: 'paymentSessions', value: 37, source: 'seat-redis', measuredAtMs: CYCLE },
        ],
        unavailable: [],
        podName: 'purchase-svc-7c9',
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ scope: SCOPE, kind: 'CONTROL_KIND_SALE_PAUSE', keys: [...KEYS] });
    } finally {
      transport.close();
    }
  });

  test('TR-02 ② 어댑터를 거치면 센 값과 measuredAt이 그대로 dry-run 센 값이 되고, 요청 밖 키·꼴 틀린 값은 들이지 않는다', async () => {
    const { address } = await servePreview((_call, cb) =>
      cb(null, {
        counts: [
          { key: 'purchaseSessions', value: 5, source: 'seat-redis', measured_at: ts(CYCLE) },
          { key: 'waiting', value: 9, source: 'queue-redis', measured_at: ts(CYCLE) },
          { key: 'paymentSessions', value: -1, source: 'seat-redis', measured_at: ts(CYCLE) },
        ],
        unavailable: [{ key: 'paymentSessions', reason: 'invalid-count' }],
        pod_name: 'purchase-svc-1',
      }),
    );
    const transport = new GrpcControlTransport();
    try {
      const source = new ControlPreviewDryRunSource({ targets: targetsOf(address), transport });
      const r = await source.count(salePauseCount, [...KEYS], NOW);
      expect(r.counted).toEqual([{ key: 'purchaseSessions', value: 5, source: 'seat-redis', measuredAt: new Date(CYCLE).toISOString() }]);
      expect(await unavailableReason(r)).toEqual({ paymentSessions: 'invalid-count' });
    } finally {
      transport.close();
    }
  });

  test('TR-02 ③ 받는 쪽이 DEADLINE_EXCEEDED(4)로 답하면 receiver-timeout:<서비스>, UNAVAILABLE not-leader는 receiver-unavailable:<서비스>다', async () => {
    const timeout = await servePreview((_call, cb) => cb(Object.assign(new Error('deadline'), { code: grpc.status.DEADLINE_EXCEEDED, details: 'deadline' })));
    const notLeader = await servePreview((_call, cb) => cb(Object.assign(new Error('not-leader'), { code: grpc.status.UNAVAILABLE, details: 'not-leader' })));
    const transport = new GrpcControlTransport();
    try {
      const timedOut = await new ControlPreviewDryRunSource({ targets: targetsOf(timeout.address), transport }).count(salePauseCount, [...KEYS], NOW);
      expect(await unavailableReason(timedOut)).toEqual({ purchaseSessions: 'receiver-timeout:purchase-svc', paymentSessions: 'receiver-timeout:purchase-svc' });

      const unavailable = await new ControlPreviewDryRunSource({ targets: targetsOf(notLeader.address), transport }).count(salePauseCount, [...KEYS], NOW);
      expect(await unavailableReason(unavailable)).toEqual({ purchaseSessions: 'receiver-unavailable:purchase-svc', paymentSessions: 'receiver-unavailable:purchase-svc' });
      expect(unavailable.counted).toEqual([]);
    } finally {
      transport.close();
    }
  });

  test('TR-02 ④ 주소가 닿지 않으면(연결 거절) 어댑터는 그 서비스 키를 receiver-unavailable로 남긴다', async () => {
    const server = await servePreview((_call, cb) => cb(null, { counts: [], unavailable: [], pod_name: 'p' }));
    const address = server.address;
    // 서버를 닫아 연결을 거절시킨다
    await new Promise<void>((r) => servers.pop()!.tryShutdown(() => r()));
    const transport = new GrpcControlTransport();
    try {
      const r = await new ControlPreviewDryRunSource({ targets: targetsOf(address), transport, timeoutMs: 400 }).count(salePauseCount, [...KEYS], NOW);
      expect(await unavailableReason(r)).toEqual({ purchaseSessions: 'receiver-unavailable:purchase-svc', paymentSessions: 'receiver-unavailable:purchase-svc' });
    } finally {
      transport.close();
    }
  });
});
