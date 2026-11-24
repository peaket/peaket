// identity 법정 접속기록 줄(docs/features/identity.md §9, ASVS v5.0.0-16.3.1·16.3.2).
// 로그인·로그아웃·재인증·토큰 갱신의 성공·실패를 표준 출력 한 줄(JSON)로 쓴다.
// 에이전트 수집기의 법정 사본 갈래만 이 줄을 읽어 접속기록 DB로 보낸다. 일반 로그 갈래는 이 줄을 버린다.
// 싣는 칸: 일시(KST 오프셋), 이벤트, 결과, 제공자, 확인 요소, 실패 종류, 작업 묶음, 원문 IP, 단말 정보,
// 요청 ID, 계정 ID, 파드, 파드마다 늘어나기만 하는 일련번호. 비밀 값·쿠키·본문은 싣지 않는다.
import { hostname } from 'node:os';

export type LegalAccessEvent = 'LOGIN' | 'LOGOUT' | 'REAUTH' | 'REFRESH';
export type LegalAccessResult = 'SUCCESS' | 'FAILED';
export type LegalAccessFailure = 'password' | 'totp' | 'passkey' | 'locked' | 'session';
export type LegalAccessFactor = 'password' | 'totp' | 'passkey';

export interface LegalAccessInput {
  event: LegalAccessEvent;
  result: LegalAccessResult;
  /** 소셜 제공자(kakao·naver·google) */
  provider?: string;
  /** 팬 재인증 강도(예: social) [가정] */
  strength?: string;
  /** 확인한 인증 요소(관리 계정 재인증) */
  factors?: readonly LegalAccessFactor[];
  /** 실패 종류(실패 줄에만) */
  failure?: LegalAccessFailure;
  /** 관리 계정 재인증의 작업 묶음 */
  act?: string;
  /** 게이트웨이가 넘긴 원문 IP. 법정 접속기록에만 싣는다 */
  clientIp?: string;
  userAgent?: string | null;
  requestId?: string;
  accountId?: string;
}

export interface LegalAccessLog {
  record(input: LegalAccessInput): void;
}

const EVENTS: ReadonlySet<string> = new Set(['LOGIN', 'LOGOUT', 'REAUTH', 'REFRESH']);
const RESULTS: ReadonlySet<string> = new Set(['SUCCESS', 'FAILED']);
const FAILURES: ReadonlySet<string> = new Set(['password', 'totp', 'passkey', 'locked', 'session']);
const FACTORS: ReadonlySet<string> = new Set(['password', 'totp', 'passkey']);
/** 단말 정보는 512자까지만 싣는다(세션의 화면용 기기 이름과 같은 한도) */
const USER_AGENT_MAX = 512;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 주입한 시계의 벽시계 값을 KST 오프셋 ISO 8601로 쓴다(정규 로그 줄과 같은 꼴) */
const kstIso = (ms: number): string => new Date(ms + KST_OFFSET_MS).toISOString().replace('Z', '+09:00');

export interface LegalAccessLogOptions {
  write(line: string): void;
  now(): number;
  pod: string;
}

export function createLegalAccessLog(o: LegalAccessLogOptions): LegalAccessLog {
  if (typeof o.write !== 'function' || typeof o.now !== 'function') throw new Error('법정 접속기록 줄을 쓸 곳과 시계가 필요하다');
  let serial = 0;
  return {
    record(input) {
      if (!EVENTS.has(input?.event)) throw new Error(`모르는 접속기록 이벤트다: ${input?.event}`);
      if (!RESULTS.has(input?.result)) throw new Error(`모르는 접속기록 결과다: ${input?.result}`);
      if (input.result === 'FAILED' && !FAILURES.has(input.failure ?? '')) throw new Error(`실패 줄에는 알려진 실패 종류가 필요하다: ${input.failure}`);
      if (input.result === 'SUCCESS' && input.failure !== undefined) throw new Error('성공 줄에는 실패 종류를 싣지 않는다');
      for (const f of input.factors ?? []) if (!FACTORS.has(f)) throw new Error(`모르는 인증 요소다: ${f}`);
      const line: Record<string, unknown> = {
        kind: 'legal-access',
        service: 'identity-svc',
        ts: kstIso(o.now()),
        event: input.event,
        result: input.result,
        seq: ++serial,
        pod: o.pod,
      };
      if (input.provider !== undefined) line.provider = input.provider;
      if (input.strength !== undefined) line.strength = input.strength;
      if (input.factors !== undefined) Object.assign(line, { factors: [...input.factors] });
      if (input.failure !== undefined) line.failure = input.failure;
      if (input.act !== undefined) line.act = input.act;
      if (input.clientIp !== undefined) line.client_ip = input.clientIp;
      if (input.userAgent !== undefined && input.userAgent !== null) line.user_agent = input.userAgent.slice(0, USER_AGENT_MAX);
      if (input.requestId !== undefined) line.request_id = input.requestId;
      if (input.accountId !== undefined) line.account_id = input.accountId;
      o.write(JSON.stringify(line));
    },
  };
}

// 프로세스 하나에 하나. 파드가 다시 뜨면 1부터 다시 세고, 대조는 파드별로 본다.
const singleton = createLegalAccessLog({
  write: (line) => process.stdout.write(`${line}\n`),
  now: () => Date.now(),
  pod: process.env.PEAKET_POD ?? hostname(),
});

export function recordLegalAccess(input: LegalAccessInput): void {
  singleton.record(input);
}
