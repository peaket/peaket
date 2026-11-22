// F-02-1 리뷰 반영 재현 RV-04 ①(계획 15절): 제어 gRPC 부름마다의 데드라인 1초(control-tower §5 '직접 제어 채널' 데드라인 1초 [가정], ADR-0365 결정 4).
// 답하지 않는 실제 gRPC 받는 쪽(계약 원본 control.proto)을 띄우고, ops-svc의 GrpcControlTransport(운영 조립과 같은 보내기)가 1,000ms에 끊는지 본다.
// 실제 포트·실제 시계를 쓰므로 통합 시험이다. 경계는 '1초 + 여유 0.8초 안에 DEADLINE_EXCEEDED, 0.9초 전에는 끊지 않음'으로 본다(데드라인을 10초로 바꾸면 실패한다).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { GrpcControlTransport } from '../src/adapters/grpc-control-sender.js';

const DEADLINE_MS = 1_000;
const PROTO_ROOT = fileURLToPath(new URL('../../../docs/api/proto', import.meta.url));
let server: grpc.Server;
let address: string;
let received = 0;

beforeAll(async () => {
  const def = protoLoader.loadSync('peaket/control/v1/control.proto', { includeDirs: [PROTO_ROOT], keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
  const pkg = grpc.loadPackageDefinition(def) as unknown as { peaket: { control: { v1: { ControlReceiver: { service: grpc.ServiceDefinition } } } } };
  server = new grpc.Server();
  // 답하지 않는 받는 쪽(이벤트 루프가 막힌 파드처럼): 콜백을 부르지 않는다
  server.addService(pkg.peaket.control.v1.ControlReceiver.service, { ApplyControl: () => void (received += 1) });
  const port = await new Promise<number>((res, rej) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
  address = `127.0.0.1:${port}`;
});

afterAll(() => {
  server?.forceShutdown();
});

describe('RV-04 제어 gRPC 부름마다 데드라인 1초 (ASVS v5.0.0-15.1.3)', () => {
  test('RV-04 ① 답하지 않는 받는 쪽에 보낸 ApplyControl은 1,000ms에 DEADLINE_EXCEEDED로 끊긴다(0.9초 전에는 끊지 않고 1.8초 안에 끊는다)', async () => {
    const transport = new GrpcControlTransport();
    const started = Date.now();
    const outcome = await transport.apply('queue-svc', address, { commandId: randomUUID(), scope: randomUUID(), kind: 'CONTROL_KIND_SALE_PAUSE', version: 1_000, desiredStateJson: '{"paused":true}' }).then(
      () => ({ code: -1 }),
      (e: { code?: number }) => ({ code: e.code ?? -2 }),
    );
    const elapsed = Date.now() - started;
    expect(outcome).toEqual({ code: grpc.status.DEADLINE_EXCEEDED });
    expect(received, '받는 쪽에 닿지 않았다(연결 오류로 끊겼다)').toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 100);
    expect(elapsed).toBeLessThan(DEADLINE_MS + 800);
  }, 15_000);
});
