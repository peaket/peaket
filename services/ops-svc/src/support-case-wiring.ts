// ops-svc 시작 조립: core SupportCaseService gRPC 클라이언트(F-06-5). PEAKET_CORE_GRPC_URL·PEAKET_INTERNAL_TOKEN.
// staging·prod는 주소가 없으면 변수 이름을 말하며 던진다. local·ci·demo는 비어 있으면 undefined다.
import { GrpcSupportCases, type SupportCaseReplyPort } from './modules/cases/index.js';

const REQUIRED_IN = new Set(['staging', 'prod', 'production']);
const value = (env: Record<string, string | undefined>, name: string): string | undefined => {
  const v = env[name]?.trim();
  return v ? v : undefined;
};

export function supportCasePortsFromEnv(env: Record<string, string | undefined>): SupportCaseReplyPort | undefined {
  const peaketEnv = value(env, 'PEAKET_ENV') ?? 'local';
  const url = value(env, 'PEAKET_CORE_GRPC_URL');
  if (REQUIRED_IN.has(peaketEnv) && !url) throw new Error(`PEAKET_CORE_GRPC_URL이 없다(${peaketEnv}에서 CS 답변을 core-svc로 보내야 시작한다, host:port)`);
  if (!url) return undefined;
  return new GrpcSupportCases({ url, ...(value(env, 'PEAKET_INTERNAL_TOKEN') ? { token: value(env, 'PEAKET_INTERNAL_TOKEN')! } : {}) });
}
