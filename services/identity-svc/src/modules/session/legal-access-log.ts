// identity 법정 접속기록 줄(docs/features/identity.md §9, ASVS v5.0.0-16.3.1·16.3.2).
// 로그인·로그아웃·재인증·토큰 갱신의 성공·실패를 표준 출력 한 줄(JSON)로 쓴다.
// 에이전트 수집기의 법정 사본 갈래만 이 줄을 읽어 접속기록 DB로 보낸다. 일반 로그 갈래는 이 줄을 버린다.
// 싣는 칸: 일시(KST 오프셋), 이벤트, 결과, 제공자, 확인 요소, 실패 종류, 작업 묶음, 원문 IP, 단말 정보,
// 요청 ID, 계정 ID, 관리 계정 표시, 파드, 파드마다 늘어나기만 하는 일련번호. 비밀 값·쿠키·본문은 싣지 않는다.
// 일련번호는 파일에 이어 써서 프로세스가 다시 떠도 1로 돌아가지 않는다(IR-13).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

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
  /** 관리 계정(ops·partner) 줄이면 1. al_admin_reader 행 정책의 대상이 된다 */
  isAdmin?: boolean;
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

/** 파일에 적힌 마지막 일련번호. 없거나 망가졌으면 0부터 센다. */
function readSerial(path: string | undefined): number {
  if (!path || !existsSync(path)) return 0;
  try {
    const n = Number(readFileSync(path, 'utf8').trim());
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** 다음 일련번호를 파일에 먼저 적는다. 적지 못하면 이 프로세스 안에서만 이어 센다(줄은 그대로 쓴다). */
function writeSerial(path: string | undefined, n: number): void {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${n}\n`);
  } catch {
    // 볼륨이 없거나 권한이 없으면 메모리 셈으로 이어 간다. 줄을 잃는 것보다 낫다.
  }
}

export interface LegalAccessLogOptions {
  write(line: string): void;
  now(): number;
  pod: string;
  /** 일련번호를 이어 쓸 파일. 없으면 프로세스 안에서만 센다(시험·개발) */
  statePath?: string;
}

export function createLegalAccessLog(o: LegalAccessLogOptions): LegalAccessLog {
  if (typeof o.write !== 'function' || typeof o.now !== 'function') throw new Error('법정 접속기록 줄을 쓸 곳과 시계가 필요하다');
  let serial = readSerial(o.statePath);
  return {
    record(input) {
      if (!EVENTS.has(input?.event)) throw new Error(`모르는 접속기록 이벤트다: ${input?.event}`);
      if (!RESULTS.has(input?.result)) throw new Error(`모르는 접속기록 결과다: ${input?.result}`);
      if (input.result === 'FAILED' && !FAILURES.has(input.failure ?? '')) throw new Error(`실패 줄에는 알려진 실패 종류가 필요하다: ${input.failure}`);
      if (input.result === 'SUCCESS' && input.failure !== undefined) throw new Error('성공 줄에는 실패 종류를 싣지 않는다');
      for (const f of input.factors ?? []) if (!FACTORS.has(f)) throw new Error(`모르는 인증 요소다: ${f}`);
      serial += 1;
      writeSerial(o.statePath, serial);
      const line: Record<string, unknown> = {
        kind: 'legal-access',
        service: 'identity-svc',
        ts: kstIso(o.now()),
        event: input.event,
        result: input.result,
        is_admin: input.isAdmin === true ? 1 : 0,
        seq: serial,
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

// 프로세스 하나에 하나. 파드가 다시 떠도 같은 파일을 이어 써서 일련번호가 중복되지 않는다.
const statePath = process.env.PEAKET_LEGAL_ACCESS_SEQ_FILE ?? '/var/lib/identity/legal-access-seq';
const singleton = createLegalAccessLog({
  write: (line) => process.stdout.write(`${line}\n`),
  now: () => Date.now(),
  pod: process.env.PEAKET_POD ?? hostname(),
  statePath,
});

export function recordLegalAccess(input: LegalAccessInput): void {
  singleton.record(input);
}
