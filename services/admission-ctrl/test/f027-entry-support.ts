// IR027-01·02 진입점 시나리오를 C-T13 시험 안에서 돌리는 보조. 별도 test()를 만들지 않아 시험 수를 늘리지 않는다.
// 실제 gRPC 서버·파일 감사 sink를 쓰고, KMS만 시험용 P-256 키로 바꾼다.
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { controlV1Control } from '@peaket/contracts/proto';
import { expect } from 'vitest';
import { runRunbookCliMain } from '../src/runbook-cli-main.js';

const EVENT = '0193a000-0000-7000-9000-0000000000e1';
const COMMAND = '0193a000-0000-7000-9000-00000000c001';
const UUID = (n: number): string => `0193a000-0000-7000-9000-00000000c${String(n).padStart(3, '0')}`;

interface Key {
  id: string;
  role: 'commander' | 'operator';
  publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'];
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  kmsKeyArn: string;
}
const keyOf = (id: string, role: Key['role']): Key => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { id, role, publicKey, privateKey, kmsKeyArn: `arn:aws:kms:ap-northeast-2:000000000000:key/${id}` };
};
const commanderA = keyOf('commander-a', 'commander');
const commanderB = keyOf('commander-b', 'commander');
const operatorC = keyOf('operator-c', 'operator');
const byArn = new Map([commanderA, commanderB, operatorC].map((k) => [k.kmsKeyArn, k]));

const keyList = (keys: readonly Key[]): string =>
  JSON.stringify(keys.map((k) => ({ id: k.id, operatorId: k.id, role: k.role, publicKey: k.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), kmsKeyArn: k.kmsKeyArn })));

const kmsSign = async (keyId: string, message: Buffer): Promise<Buffer> => {
  const k = byArn.get(keyId);
  if (!k) throw new Error(`모르는 KMS 키: ${keyId}`);
  return sign('sha256', message, { key: k.privateKey, dsaEncoding: 'der' });
};

export async function runEntrypointScenario(): Promise<void> {
  const protoOptions: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
  const def = protoLoader.fromJSON(controlV1Control as Parameters<typeof protoLoader.fromJSON>[0], protoOptions);
  const pkg = grpc.loadPackageDefinition(def) as unknown as { peaket: { control: { v1: { ControlReceiver: { service: grpc.ServiceDefinition } } } } };
  let calls = 0;
  let bundleBytes = 0;
  const server = new grpc.Server();
  server.addService(pkg.peaket.control.v1.ControlReceiver.service, {
    ApplyControl: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      calls += 1;
      const bundle = call.request.runbook_bundle as { canonical_bundle?: Uint8Array } | undefined;
      bundleBytes = bundle?.canonical_bundle?.length ?? 0;
      cb(null, { applied_version: Number(call.request.version ?? 0), pod_name: 'entry-pod', applied_at: { seconds: Math.floor(Date.now() / 1000), nanos: 0 } });
    },
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? reject(e) : resolve(p)));
  });
  server.start();
  try {
    const dir = mkdtempSync(join(tmpdir(), 'peaket-runbook-'));
    const address = `127.0.0.1:${port}`;
    const env = {
      PEAKET_ENV: 'ci',
      PEAKET_RUNBOOK_COMMANDER_KEYS: keyList([commanderA, commanderB, operatorC]),
      PEAKET_RUNBOOK_AUDIT_DIR: dir,
      PEAKET_PURCHASE_CONTROL_GRPC_ADDRS: address,
      PEAKET_ADMISSION_CONTROL_GRPC_ADDRS: address,
      PEAKET_QUEUE_CONTROL_GRPC_ADDRS: address,
    };
    const out = join(dir, 'bundle.json');
    const lines: string[] = [];
    expect(await runRunbookCliMain({ argv: ['draft', 'sale-pause', '--event', EVENT, '--reason', '결제사 장애로 판매를 멈춘다', '--command-id', COMMAND, '--out', out], env, kmsSign, print: (l) => lines.push(l) })).toBe(0);
    expect(await runRunbookCliMain({ argv: ['sign', '--in', out, '--signer', 'commander-a'], env, kmsSign, print: (l) => lines.push(l) })).toBe(0);
    expect(await runRunbookCliMain({ argv: ['run', '--in', out], env, kmsSign, print: (l) => lines.push(l) })).toBe(0);
    expect(calls).toBe(3);
    expect(bundleBytes).toBeGreaterThan(0);
    const intent = JSON.parse(readFileSync(join(dir, COMMAND, 'intent.json'), 'utf8')) as { v: number; type: string; services: string[] };
    const result = JSON.parse(readFileSync(join(dir, COMMAND, 'result.json'), 'utf8')) as { v: number; type: string; outcome: string; applied: unknown[] };
    expect(intent).toMatchObject({ v: 1, type: 'intent' });
    expect(intent.services.sort()).toEqual(['admission-ctrl', 'purchase-svc', 'queue-svc']);
    expect(result).toMatchObject({ v: 1, type: 'result', outcome: 'APPLIED' });
    expect(result.applied).toHaveLength(3);

    const prodDir = mkdtempSync(join(tmpdir(), 'peaket-runbook-'));
    const argv = ['draft', 'sale-pause', '--event', EVENT, '--reason', '비상', '--command-id', UUID(2), '--out', join(prodDir, 'b.json')];
    await expect(runRunbookCliMain({ argv, env: { PEAKET_ENV: 'prod' } })).rejects.toThrow();
    await expect(runRunbookCliMain({ argv, env: { PEAKET_ENV: 'prod', PEAKET_RUNBOOK_COMMANDER_KEYS: keyList([commanderA, operatorC]) } })).rejects.toThrow();
  } finally {
    server.forceShutdown();
  }
}
