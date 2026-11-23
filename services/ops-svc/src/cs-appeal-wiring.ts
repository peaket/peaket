// 추가 검증 이의 처리 포트의 시작 조립(F-06-7 GAT-280, bot-defense §12 'CS 처리 첫 구현' '다시 보내기' 끝).
// 주소: PEAKET_QUEUE_GRPC_URL(queue-svc VerificationAppealService), PEAKET_TRUST_GRPC_URL(trust-svc TrustLabelService·TrustEvidenceService),
// PEAKET_IDENTITY_GRPC_URL(identity-svc AccountHoldService). 주소가 있는 칸만 실제 gRPC 클라이언트를 만든다.
// staging·prod는 queue·trust 주소가 없으면 시작하지 않는다(그 변수 이름을 말하며 던진다). local·ci·demo는 없으면 칸이 비고,
// 보낼 호출은 NOT_CONFIGURED로 쌓아 다시 보낸다(main.ts가 경고 로그를 남긴다).
import { GrpcAccountHolds, GrpcAppealLabels, GrpcVerdictEvidence, GrpcVerificationAppeals } from './modules/cases/index.js';

export interface CsAppealPortsWiring {
  readonly appeals?: GrpcVerificationAppeals;
  readonly labels?: GrpcAppealLabels;
  readonly evidence?: GrpcVerdictEvidence;
  readonly holds?: GrpcAccountHolds;
  /** 주소가 없어 비운 칸의 변수 이름(경고 로그용) */
  readonly missing: readonly string[];
  close(): void;
}

const REQUIRED_IN = new Set(['staging', 'prod', 'production']);
const value = (env: Record<string, string | undefined>, name: string): string | undefined => {
  const v = env[name]?.trim();
  return v ? v : undefined;
};

export function csAppealPortsFromEnv(env: Record<string, string | undefined>): CsAppealPortsWiring {
  const peaketEnv = value(env, 'PEAKET_ENV') ?? 'local';
  const queue = value(env, 'PEAKET_QUEUE_GRPC_URL');
  const trust = value(env, 'PEAKET_TRUST_GRPC_URL');
  const identity = value(env, 'PEAKET_IDENTITY_GRPC_URL');
  if (REQUIRED_IN.has(peaketEnv)) {
    if (!queue) throw new Error(`PEAKET_QUEUE_GRPC_URL이 없다(${peaketEnv}의 ops-svc는 추가 검증 이의 결과를 queue-svc에 반영해야 시작한다, host:port)`);
    if (!trust) throw new Error(`PEAKET_TRUST_GRPC_URL이 없다(${peaketEnv}의 ops-svc는 추가 검증 이의 라벨·판정 근거를 trust-svc로 읽고 써야 시작한다, host:port)`);
  }
  const token = value(env, 'PEAKET_INTERNAL_GRPC_TOKEN');
  const base = token ? { token } : {};
  const appeals = queue ? new GrpcVerificationAppeals({ address: queue, envName: 'PEAKET_QUEUE_GRPC_URL', ...base }) : undefined;
  const labels = trust ? new GrpcAppealLabels({ address: trust, envName: 'PEAKET_TRUST_GRPC_URL', ...base }) : undefined;
  const evidence = trust ? new GrpcVerdictEvidence({ address: trust, envName: 'PEAKET_TRUST_GRPC_URL', ...base }) : undefined;
  const holds = identity ? new GrpcAccountHolds({ address: identity, envName: 'PEAKET_IDENTITY_GRPC_URL', ...base }) : undefined;
  const missing = [...(queue ? [] : ['PEAKET_QUEUE_GRPC_URL']), ...(trust ? [] : ['PEAKET_TRUST_GRPC_URL']), ...(identity ? [] : ['PEAKET_IDENTITY_GRPC_URL'])];
  return {
    ...(appeals ? { appeals } : {}),
    ...(labels ? { labels } : {}),
    ...(evidence ? { evidence } : {}),
    ...(holds ? { holds } : {}),
    missing,
    close() {
      appeals?.close();
      labels?.close();
      evidence?.close();
      holds?.close();
    },
  };
}
