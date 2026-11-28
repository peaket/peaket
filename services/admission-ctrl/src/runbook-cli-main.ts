// peaket-runbook 진입점 조립(IR027-01·02): 제어 갈래는 대기열 Redis를 열지 않고 실제 gRPC·감사·주소로 간다.
// RB-35 갈래만 대기열 Redis를 연다. KMS·S3 Object Lock은 포트·미실행 골격이다.
import { readFileSync, writeFileSync } from 'node:fs';
import { KMSClient } from '@aws-sdk/client-kms';
import { type Clock, systemClock } from '@peaket/platform';
import { RedisBatchStore } from './modules/batch/index.js';
import { commanderKeysFromProcess, kmsRunbookSigner, RedisRb35Store, runRunbookCli, type Rb35Store, type RunbookDeps } from './modules/rb35/index.js';
import { FileRunbookAuditSink, GrpcRunbookControlTransport, isControlFile, isControlPreset, S3RunbookAuditSink, type RunbookControlService } from './modules/runbook/index.js';

const LOCAL_ENVS = ['local', 'ci', 'demo'];
const CONTROL_ADDR_ENV: Readonly<Record<RunbookControlService, string>> = {
  'purchase-svc': 'PEAKET_PURCHASE_CONTROL_GRPC_ADDRS',
  'admission-ctrl': 'PEAKET_ADMISSION_CONTROL_GRPC_ADDRS',
  'queue-svc': 'PEAKET_QUEUE_CONTROL_GRPC_ADDRS',
  'payment-svc': 'PEAKET_PAYMENT_CONTROL_GRPC_ADDRS',
};

/** 제어 갈래인가(대기열 Redis를 열기 전에 argv와 파일만으로 가른다) */
export function isControlInvocation(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): boolean {
  const [sub, first] = argv;
  if (sub === 'draft') return isControlPreset(first);
  if (sub !== 'sign' && sub !== 'run') return false;
  const at = argv.indexOf('--in');
  const path = at >= 0 ? argv[at + 1] : undefined;
  if (!path) return false;
  try {
    return isControlFile({ readFile: (p: string) => readFileSync(p, 'utf8') } as never, path);
  } catch {
    return false;
  }
}

function controlAddresses(env: Readonly<Record<string, string | undefined>>): Partial<Record<RunbookControlService, string[]>> {
  const out: Partial<Record<RunbookControlService, string[]>> = {};
  for (const [service, name] of Object.entries(CONTROL_ADDR_ENV) as [RunbookControlService, string][]) {
    const list = (env[name] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length > 0) out[service] = list;
  }
  return out;
}

function auditSinkFromEnv(env: Readonly<Record<string, string | undefined>>) {
  const dir = env.PEAKET_RUNBOOK_AUDIT_DIR;
  if (dir) return new FileRunbookAuditSink(dir);
  const bucket = env.PEAKET_RUNBOOK_AUDIT_BUCKET;
  if (bucket) return new S3RunbookAuditSink(bucket);
  return undefined;
}

const noStore: Rb35Store = {
  scheduleOf: async () => {
    throw new Error('제어 갈래는 RB-35 저장소를 쓰지 않는다');
  },
  state: async () => {
    throw new Error('제어 갈래는 RB-35 저장소를 쓰지 않는다');
  },
  deposit: async () => {
    throw new Error('제어 갈래는 RB-35 저장소를 쓰지 않는다');
  },
  pending: async () => {
    throw new Error('제어 갈래는 RB-35 저장소를 쓰지 않는다');
  },
  apply: async () => {
    throw new Error('제어 갈래는 RB-35 저장소를 쓰지 않는다');
  },
  reject: async () => {
    throw new Error('제어 갈래는 RB-35 저장소를 쓰지 않는다');
  },
  result: async () => {
    throw new Error('제어 갈래는 RB-35 저장소를 쓰지 않는다');
  },
};

export interface RunbookCliMainOptions {
  readonly argv: string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 시험만 KMS 서명을 바꾼다(실제 KMS는 미실행) */
  readonly kmsSign?: (keyId: string, message: Buffer) => Promise<Buffer>;
  readonly print?: (line: string) => void;
  readonly clock?: Clock;
}

export async function runRunbookCliMain(o: RunbookCliMainOptions): Promise<number> {
  const env = o.env;
  const clock = o.clock ?? systemClock;
  const print = o.print ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const keys = commanderKeysFromProcess(env as Record<string, string | undefined>);
  const control = isControlInvocation(o.argv, env);
  const kms =
    o.kmsSign ??
    (() => {
      const region = env.AWS_REGION ?? 'ap-northeast-2';
      const endpoint = env.PEAKET_KMS_ENDPOINT;
      if (endpoint && !LOCAL_ENVS.includes(env.PEAKET_ENV ?? 'prod')) throw new Error(`PEAKET_KMS_ENDPOINT는 ${LOCAL_ENVS.join('·')}에서만 쓴다`);
      const client = new KMSClient({ region, ...(endpoint ? { endpoint } : {}), maxAttempts: 2, requestHandler: { connectionTimeout: 1_000, requestTimeout: 2_000, throwOnRequestTimeout: true } });
      return kmsRunbookSigner(client);
    })();
  const common: RunbookDeps = {
    store: noStore,
    clock,
    keys,
    readFile: (p) => readFileSync(p, 'utf8'),
    writeFile: (p, s) => writeFileSync(p, s, 'utf8'),
    print,
    kmsSign: kms,
    ...(env.PEAKET_RUNBOOK_SIGNING_KEY ? { defaultSigningKey: env.PEAKET_RUNBOOK_SIGNING_KEY } : {}),
    allowSimulator: LOCAL_ENVS.includes(env.PEAKET_ENV ?? 'prod'),
  };
  if (control) {
    const transport = new GrpcRunbookControlTransport();
    const audit = auditSinkFromEnv(env);
    try {
      return await runRunbookCli(o.argv, {
        ...common,
        control: transport,
        ...(audit ? { audit } : {}),
        controlAddresses: controlAddresses(env),
      });
    } finally {
      transport.close();
    }
  }

  // RB-35 갈래만 대기열 Redis를 연다
  const clusterUrls = (env.PEAKET_QUEUE_REDIS_CLUSTER_URLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const url = env.PEAKET_QUEUE_REDIS_URL;
  if (!url && clusterUrls.length === 0) throw new Error('PEAKET_QUEUE_REDIS_URL이나 PEAKET_QUEUE_REDIS_CLUSTER_URLS가 없다');
  const { createHotRedis } = await import('@peaket/platform');
  const redis = await createHotRedis(clusterUrls.length > 0 ? { clusterUrls } : { url });
  try {
    return await runRunbookCli(o.argv, { ...common, store: new RedisRb35Store(redis, new RedisBatchStore(redis)) });
  } finally {
    await redis.close();
  }
}
