// 부스 재발급 코드·허용·BOOTH 등록의 순수 규칙(openapi createTicketBoothRequest·createScannerBoothAuthorization,
// docs/features/offline-gate.md §9.1 '부스 재발급', docs/design/d5 §5.13·§8.5, docs/review/plans/F-05-12.md §3 결정 2~4).
// 코드는 혼동 글자(I·O·0·1)를 뺀 32글자 가운데 8자, 코드 10분·허용 10분·하루 3회 [가정]다.
import { createHash, randomInt } from 'node:crypto';

export const BOOTH_CODE_TTL_MS = 10 * 60_000;
export const BOOTH_PERMIT_TTL_MS = 10 * 60_000;
export const BOOTH_REQUESTS_PER_DAY = 3;
export const BOOTH_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE = new RegExp(`^[${BOOTH_CODE_ALPHABET}]{8}$`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class BoothInputError extends Error {
  constructor(readonly code: 'CODE' | 'BODY') {
    super(code === 'CODE' ? '부스 코드는 8자여야 한다' : '부스 요청 본문이 올바르지 않다');
    this.name = 'BoothInputError';
  }
}

/** 부스 코드(8자)를 검사한다. 공백은 고치지 않고 그대로 거절한다(화면이 보여 준 값만 받는다) */
export function parseBoothCode(v: unknown): string {
  if (typeof v !== 'string' || !CODE.test(v)) throw new BoothInputError('CODE');
  return v;
}

export function newBoothCode(): string {
  return Array.from({ length: 8 }, () => BOOTH_CODE_ALPHABET[randomInt(BOOTH_CODE_ALPHABET.length)]!).join('');
}

export function boothHash(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** 하루 3회 [가정]를 세는 KST 날짜(yyyy-mm-dd). UTC로 세면 자정 근처에서 어긋난다 */
export function boothDayKey(nowMs: number): string {
  return new Date(nowMs + 9 * 60 * 60_000).toISOString().slice(0, 10);
}

export const isBoothTicketId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export type BoothRequestOutcome =
  | { kind: 'created'; boothRequestId: string; expiresAtMs: number }
  | { kind: 'not_found' }
  | { kind: 'before_entry' }
  | { kind: 'mismatch' }
  | { kind: 'limit' };

export type BoothAuthorizeOutcome =
  | { kind: 'authorized'; ticketId: string; seatLabel: string; allowUntilMs: number }
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'event_mismatch' };

export interface GateStatusDeviceView {
  deviceId: string;
  name: string;
  placement?: { gateZone: string; mode: 'IN' | 'OUT'; version?: number };
  ready: boolean;
  packageSeq?: number;
  lastSyncAt?: string;
  pendingUploads: number;
  staffLoggedIn?: boolean;
}

/** SCR-052 기기 현황(openapi GateStatus). 계정·전화번호 같은 개인정보는 싣지 않는다 */
export interface GateStatusView {
  devices: GateStatusDeviceView[];
  entriesByZone: Record<string, number>;
  rejectsByReason: Record<string, number>;
  openFlags: number;
  boothCount: number;
  overrideCount: number;
  entryClosedAt?: string;
}

export type OverrideReviewStatus = 'WAITING' | 'OK' | 'SUSPECT' | 'UNDETERMINED';

/** SCR-052 내 예외 통과 한 줄(d5 §8.5 ⑥). 그 스태프 계정이 한 OVERRIDE만 온다 */
export interface OverridePassView {
  scanId: string;
  at: string;
  ticketId: string;
  seatLabel: string;
  reason: string;
  note?: string;
  reviewStatus: OverrideReviewStatus;
}
