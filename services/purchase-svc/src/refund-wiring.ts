// 환급 실행기의 입장 기록 대조 조립(BAT-420 GAT-090 A6). relay-app.ts·start.ts가 부르고, 시험이 시작 조립 규칙을 따로 띄워 본다
// (architecture §8.6 '자주 놓친 결함': 시작 파일 조립은 시험 조립과 따로).
// ticket-svc 주소(GrpcTicketCancellations)가 있으면 그것을 쓰고, 없으면 local·ci만 대역(모든 표 found 참·entered 거짓)이며 그 밖 환경은 시작 실패다.
// 팬 취소의 재인증 확인기 조립(fanReauthGateFromEnv, BAT-415-reauth)도 같은 규칙이다.
import type { Clock, ReauthJtiStore } from '@peaket/platform';
import type { EntryRecords, EntryRecordView, ReauthGate } from './modules/refund/index.js';
import { type FanReauthResult, JwksFanReauthGate } from './modules/refund/adapters/jwks-fan-reauth-gate.js';

/** 대역을 받는 환경(ticket-svc 없이 도는 로컬·CI). PEAKET_ENV가 없으면 운영으로 보고 대역을 쓰지 않는다(identity 조립과 같은 fail-closed) */
const STUB_ENVS: ReadonlySet<string> = new Set(['local', 'ci']);

const present = (v: string | undefined): boolean => typeof v === 'string' && v.trim() !== '';

/**
 * 웨이브 끝 리뷰 S1(guidelines §8.1 'ops-svc CS 처리함 내부 HTTP'): ops CS 처리함 주소(PEAKET_OPS_HTTP_URL)가 있는데 내부 토큰(PEAKET_INTERNAL_TOKEN)이 없으면
 * local·ci 밖(운영·스테이징·PEAKET_ENV 없음)은 시작하지 않는다(던짐). 모든 CS 건이 401로 조용히 막히는 것을 시작 때 막는다.
 * local·ci는 경고 한 번이다. 주소가 없으면(로그 대역을 쓰는 조립) 보지 않는다. relay-app.ts·start.ts가 부른다
 */
export function requireOpsInternalToken(o: { readonly env: Readonly<Record<string, string | undefined>>; readonly warn?: (msg: string) => void }): void {
  if (!present(o.env.PEAKET_OPS_HTTP_URL) || present(o.env.PEAKET_INTERNAL_TOKEN)) return;
  const envName = o.env.PEAKET_ENV;
  const msg = 'PEAKET_OPS_HTTP_URL은 있는데 PEAKET_INTERNAL_TOKEN이 없다(ops-svc CS 처리함이 모든 건을 401로 거절한다)';
  if (envName === undefined || !STUB_ENVS.has(envName)) throw new Error(`${msg}. 운영에서는 시작하지 않는다`);
  o.warn?.(msg);
}

export function entryRecordsFromEnv(o: { readonly env: Readonly<Record<string, string | undefined>>; readonly tickets?: EntryRecords }): EntryRecords {
  if (o.tickets) return o.tickets;
  const envName = o.env.PEAKET_ENV;
  if (envName === undefined || !STUB_ENVS.has(envName)) throw new Error('PEAKET_TICKET_GRPC_ADDR가 없다(마감 뒤 환급 전 입장 기록 대조, 운영 필수)');
  return {
    lookup: async (ticketIds) => new Map<string, EntryRecordView>(ticketIds.map((id) => [id, { found: true, entered: false }])),
  };
}

/** local·ci의 발급자 기본값 [가정](재인증을 받는 다른 서비스와 같다, docs/features/transfer-refund.md §3.1 '시작 조립') */
const DEFAULT_IDENTITY_ISSUER = 'https://identity.peaket.example';

/**
 * 팬 취소의 재인증 확인기 조립(docs/features/transfer-refund.md §3.1 '팬 취소의 재인증 확인'의 '시작 조립', R-T39 ⑥).
 * PEAKET_IDENTITY_FAN_JWKS_URL(팬 공개키 묶음 주소)이 있으면 JwksFanReauthGate(발급자 PEAKET_IDENTITY_ISSUER)를 돌려준다.
 * 주소가 없으면(빈 문자열 포함) local·ci는 undefined(닫힌 대역, 늘 403)와 경고 한 번이고, 그 밖 환경(PEAKET_ENV 없음 포함)은 던진다(시작 실패).
 * 주소는 있고 발급자가 없거나 빈 값이면 local·ci만 기본값을 쓰고 그 밖 환경은 던진다(기본값으로 조용히 떠 모든 취소가 403이 되는 것을 막는다, 리뷰 RV-06).
 * onResult(403·503의 까닭 기록)는 확인기에 그대로 넘긴다. start.ts가 예매 취소 조립(purchase DB가 있을 때) 안에서 좌석 Redis의 jti 저장소로 부른다
 */
export function fanReauthGateFromEnv(o: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly jti: ReauthJtiStore;
  readonly warn?: (msg: string) => void;
  readonly clock?: Clock;
  readonly fetch?: typeof fetch;
  readonly onResult?: (r: FanReauthResult) => void;
}): ReauthGate | undefined {
  const envName = o.env.PEAKET_ENV;
  const stubEnv = envName !== undefined && STUB_ENVS.has(envName);
  const jwksUrl = o.env.PEAKET_IDENTITY_FAN_JWKS_URL;
  if (jwksUrl !== undefined && present(jwksUrl)) {
    const issuer = o.env.PEAKET_IDENTITY_ISSUER;
    const hasIssuer = issuer !== undefined && present(issuer);
    if (!hasIssuer && !stubEnv) throw new Error('PEAKET_IDENTITY_FAN_JWKS_URL은 있는데 PEAKET_IDENTITY_ISSUER가 없다(기본값 발급자로 뜨면 팬 취소가 늘 403일 수 있다). 운영에서는 시작하지 않는다');
    return new JwksFanReauthGate({
      jwksUrl: jwksUrl.trim(),
      issuer: hasIssuer ? issuer.trim() : DEFAULT_IDENTITY_ISSUER,
      jti: o.jti,
      ...(o.clock ? { clock: o.clock } : {}),
      ...(o.fetch ? { fetch: o.fetch } : {}),
      ...(o.onResult ? { onResult: o.onResult } : {}),
    });
  }
  const msg = 'PEAKET_IDENTITY_FAN_JWKS_URL이 없다(팬 취소의 재인증 토큰을 확인하지 못해 취소가 늘 403 reauth-required다)';
  if (!stubEnv) throw new Error(`${msg}. 운영에서는 시작하지 않는다`);
  o.warn?.(msg);
  return undefined;
}

/**
 * 팬 취소 재인증의 403·503 기록을 로그 한 줄로 잇는다(docs/features/transfer-refund.md §3.1 '거절 기록', R-T39 ②, 리뷰 다시 보기 RN-03).
 * 403은 info, 503은 warn이고 칸은 사건 이름 event와 까닭 이름표 reason뿐이다(넘어온 값에 다른 칸이 있어도 옮기지 않는다.
 * 토큰·jti·계정 ID·세션 ID는 싣지 않는다). start.ts가 서비스를 만든 뒤 묶이는 로거를 감싸 넘긴다
 */
export function fanReauthResultLogger(log: { info(o: object): void; warn(o: object): void }): (r: FanReauthResult) => void {
  return (r) => {
    if (r.outcome === 'rejected') log.info({ event: 'fan_reauth_rejected', reason: r.reason });
    else log.warn({ event: 'fan_reauth_unavailable', reason: r.reason });
  };
}
