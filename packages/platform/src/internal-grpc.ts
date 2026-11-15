// 서비스 사이 gRPC의 공유 토큰(SEC-01·COV2-01). 메시 mTLS 위에 한 겹 더 두어
// 클러스터 안의 다른 워크로드가 자금·권한 경로를 그냥 부르지 못하게 한다.
// 토큰은 local·ci에서만 비워 둘 수 있고, 그 밖의 환경은 시작할 때 없으면 실패한다.
import * as grpc from '@grpc/grpc-js';
import { createHmac, timingSafeEqual } from 'node:crypto';

export const INTERNAL_GRPC_TOKEN_HEADER = 'x-peaket-internal-grpc-token';
export const INTERNAL_GRPC_CALLER_HEADER = 'x-peaket-internal-grpc-caller';
export const INTERNAL_GRPC_ACTOR_HEADER = 'x-peaket-internal-grpc-actor';
export const INTERNAL_GRPC_ACTOR_PROOF_HEADER = 'x-peaket-internal-grpc-actor-proof';

type Env = Record<string, string | undefined>;

/** 환경 값에서 내부 gRPC 토큰을 읽는다. local·ci는 없어도 되고, 그 밖은 없으면 시작을 막는다 */
export function internalGrpcTokenFromEnv(env: Env): string | undefined {
  const token = env.PEAKET_INTERNAL_GRPC_TOKEN;
  if (token !== undefined && token !== '') return token;
  const peaketEnv = env.PEAKET_ENV ?? 'prod';
  if (peaketEnv === 'local' || peaketEnv === 'ci') return undefined;
  throw new Error('PEAKET_INTERNAL_GRPC_TOKEN이 없다(운영에서는 내부 gRPC 공유 토큰이 꼭 필요하다)');
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** 호출자 신원(서비스 이름)과 처리자(관리 계정 ID)를 토큰으로 묶는 증명 */
export function internalGrpcActorProof(token: string, actor: string): string {
  return createHmac('sha256', token).update(actor, 'utf8').digest('base64url');
}

/** 메타데이터의 토큰·호출자·처리자 증명을 검사한다. ApplyLabel처럼 본문의 acted_by를 묶을 때 쓴다 */
export function verifyInternalGrpcActor(
  metadata: grpc.Metadata,
  token: string | undefined,
  expected: { caller?: string; actor?: string },
): { ok: true } | { ok: false; reason: 'token' | 'caller' | 'actor' } {
  if (!token) return { ok: false, reason: 'token' };
  const gotToken = metadata.get(INTERNAL_GRPC_TOKEN_HEADER)[0];
  if (typeof gotToken !== 'string' || !sameSecret(gotToken, token)) return { ok: false, reason: 'token' };
  const caller = metadata.get(INTERNAL_GRPC_CALLER_HEADER)[0];
  if (typeof caller !== 'string' || (expected.caller !== undefined && caller !== expected.caller)) return { ok: false, reason: 'caller' };
  if (expected.actor !== undefined) {
    const actor = metadata.get(INTERNAL_GRPC_ACTOR_HEADER)[0];
    const proof = metadata.get(INTERNAL_GRPC_ACTOR_PROOF_HEADER)[0];
    if (typeof actor !== 'string' || actor !== expected.actor) return { ok: false, reason: 'actor' };
    if (typeof proof !== 'string' || !sameSecret(proof, internalGrpcActorProof(token, expected.actor))) return { ok: false, reason: 'actor' };
  }
  return { ok: true };
}

/**
 * 서버 인터셉터. services를 주면 그 서비스 경로만 검사하고(다른 gRPC 서비스는 그대로),
 * 없으면 서버의 모든 호출을 검사한다. 토큰이 없거나 틀리면 UNAUTHENTICATED로 끝낸다.
 */
export function internalGrpcServerInterceptor(token: string, services?: readonly string[]): grpc.ServerInterceptor {
  return (method, call) => {
    const path = method.path;
    if (services && !services.some((s) => path.startsWith(`/${s}/`))) return new grpc.ServerInterceptingCall(call);
    return new grpc.ServerInterceptingCall(call, {
      start: (next) => {
        next({
          onReceiveMetadata(metadata: grpc.Metadata, nextMetadata: (m: grpc.Metadata) => void) {
            const got = metadata.get(INTERNAL_GRPC_TOKEN_HEADER)[0];
            if (typeof got === 'string' && sameSecret(got, token)) {
              nextMetadata(metadata);
              return;
            }
            call.sendStatus({ code: grpc.status.UNAUTHENTICATED, details: 'internal gRPC token required' });
          },
        } as unknown as grpc.ServerListener);
      },
    });
  };
}
