// ops 예매 제한 포트의 시작 조립(F-06-4). 주소: PEAKET_QUEUE_GRPC_URL·PEAKET_PURCHASE_GRPC_URL·PEAKET_CORE_GRPC_URL(사본),
// PEAKET_CORE_HTTP_URL(core support 내부 소명), PEAKET_IDENTITY_GRPC_URL(계정 보류, 없으면 기록만). 내부 토큰은 PEAKET_INTERNAL_GRPC_TOKEN·PEAKET_INTERNAL_TOKEN.
// staging·prod는 네 주소가 없으면 변수 이름을 말하며 던진다. local·ci·demo는 칸이 빈다.
import { GrpcAccountHolds } from './modules/cases/adapters/grpc-appeal-ports.js';
import { grpcRestrictionCopies } from './modules/restrictions/adapters/grpc-restriction-copies.js';
import { HttpAppealSource } from './modules/restrictions/adapters/http-appeal-source.js';
import type { AppealSource, FraudCaseDirectory, OpsRestrictionsWiring } from './modules/restrictions/domain/ports.js';

export type RestrictionPortsWiring = Omit<OpsRestrictionsWiring, 'store' | 'engineRef'> & { close(): void };

const REQUIRED_IN = new Set(['staging', 'prod', 'production']);
const value = (env: Record<string, string | undefined>, name: string): string | undefined => {
  const v = env[name]?.trim();
  return v ? v : undefined;
};

class LogAppealNotifier {
  constructor(private readonly logger?: { warn?: (o: object, msg: string) => void }) {}
  async send(i: { appealId: string; accountId: string; event: 'INVALID' | 'DECIDED'; result?: string }): Promise<void> {
    this.logger?.warn?.({ event: 'appeal-notice', appealId: i.appealId, notice: i.event, result: i.result }, '소명 결과 알림(로그 어댑터)');
  }
}

class UnwiredFraudCases implements FraudCaseDirectory {
  async investigatorOf(): Promise<{ assigneeId: string } | undefined> {
    return undefined;
  }
}

class UnwiredHolds {
  async set(): Promise<{ changed: boolean }> {
    return { changed: true };
  }
}

export function restrictionPortsFromEnv(env: Record<string, string | undefined>): RestrictionPortsWiring {
  const peaketEnv = value(env, 'PEAKET_ENV') ?? 'local';
  const queue = value(env, 'PEAKET_QUEUE_GRPC_URL');
  const purchase = value(env, 'PEAKET_PURCHASE_GRPC_URL');
  const coreGrpc = value(env, 'PEAKET_CORE_GRPC_URL');
  const coreHttp = value(env, 'PEAKET_CORE_HTTP_URL');
  if (REQUIRED_IN.has(peaketEnv)) {
    if (!queue) throw new Error(`PEAKET_QUEUE_GRPC_URL이 없다(${peaketEnv}에서 ops-svc가 queue-svc에 예매 제한 사본을 보내야 시작한다, host:port)`);
    if (!purchase) throw new Error(`PEAKET_PURCHASE_GRPC_URL이 없다(${peaketEnv}에서 ops-svc가 purchase-svc에 예매 제한 사본을 보내야 시작한다, host:port)`);
    if (!coreGrpc) throw new Error(`PEAKET_CORE_GRPC_URL이 없다(${peaketEnv}에서 ops-svc가 core-svc에 화면용 사본을 보내야 시작한다, host:port)`);
    if (!coreHttp) throw new Error(`PEAKET_CORE_HTTP_URL이 없다(${peaketEnv}에서 ops-svc가 core-svc 소명 원본을 읽어야 시작한다, http(s)://)`);
  }
  const grpcToken = value(env, 'PEAKET_INTERNAL_GRPC_TOKEN') ?? '';
  const httpToken = value(env, 'PEAKET_INTERNAL_TOKEN') ?? '';
  const copies = queue && purchase && coreGrpc ? grpcRestrictionCopies({ queueUrl: queue, purchaseUrl: purchase, coreUrl: coreGrpc, token: grpcToken }) : undefined;
  const appeals: AppealSource | undefined = coreHttp ? new HttpAppealSource({ url: coreHttp, token: httpToken }) : undefined;
  if (!copies && !appeals) return { close() {} };
  const identity = value(env, 'PEAKET_IDENTITY_GRPC_URL');
  const holds = identity ? new GrpcAccountHolds({ address: identity, envName: 'PEAKET_IDENTITY_GRPC_URL', ...(grpcToken ? { token: grpcToken } : {}) }) : new UnwiredHolds();
  return {
    ...(copies ? { copies } : {}),
    ...(appeals ? { appeals } : {}),
    fraudCases: new UnwiredFraudCases(),
    notifier: new LogAppealNotifier(),
    holds,
    close() {
      copies?.close();
      if (holds instanceof GrpcAccountHolds) holds.close();
    },
  };
}
