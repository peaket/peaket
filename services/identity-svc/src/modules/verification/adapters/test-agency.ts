// 모의 기관의 결과 값 형식(docs/features/identity.md §5 '모의 기관과 기관 창 흐름', BUILD_ORDER BOT-010, I-T45).
// 실제 기관이 결과를 암호화·서명해 주는 것을 흉내 낸다: 결과 본문을 JSON으로 적어 base64url로 바꾸고, 시험 기관 비밀로 HMAC-SHA256 서명한다.
// 모의 기관(scripts/mock-idv.mjs)은 따로 도는 '바깥 기관'이라 같은 형식을 따로 구현한다. 시험(mock-idv.test.ts)이 두 쪽이 맞는지 본다.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const TEST_AGENCY_OUTCOMES = ['VERIFIED', 'CANCELLED', 'FAILED', 'DOWN'] as const;
export type TestAgencyOutcome = (typeof TEST_AGENCY_OUTCOMES)[number];

/** 결과 본문(판 1). tx는 건 ID, iat는 만든 시각(밀리초), birth는 생년월일(YYYY-MM-DD, BUILD_ORDER BOT-020이 만 14세 확인에 쓴다) */
export interface TestAgencyResult {
  v: 1;
  tx: string;
  outcome: TestAgencyOutcome;
  person?: string;
  birth?: string;
  iat: number;
}

/** 브라우저가 복귀 화면을 거쳐 결과 경로로 넘기는 칸 셋(기관 값 Record<string, string>으로 넘기므로 interface가 아니라 type이다) */
export type SealedTestAgencyResult = {
  verificationId: string;
  result: string;
  mac: string;
};

const LABEL = 'peaket-test-idv-result:v1:';
const B64U = /^[A-Za-z0-9_-]+$/;
const MAC = /^[A-Za-z0-9_-]{43}$/;
const BIRTH = /^\d{4}-\d{2}-\d{2}$/;
/** 결과 본문 상한(base64url 글자 수) */
const MAX_RESULT = 2048;

const macOf = (secret: Uint8Array, result: string): Buffer => createHmac('sha256', secret).update(LABEL + result).digest();

export function sealTestAgencyResult(secret: Uint8Array, r: TestAgencyResult): SealedTestAgencyResult {
  const result = Buffer.from(JSON.stringify(r), 'utf8').toString('base64url');
  return { verificationId: r.tx, result, mac: macOf(secret, result).toString('base64url') };
}

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** 서명이 맞고 본문 모양이 맞으면 결과 본문, 아니면 null(건 ID·만든 시각이 그 건에 맞는지는 부르는 쪽이 본다) */
export function openTestAgencyResult(secret: Uint8Array, fields: Record<string, string>): TestAgencyResult | null {
  const result = fields.result;
  const mac = fields.mac;
  if (typeof result !== 'string' || result.length > MAX_RESULT || !B64U.test(result) || typeof mac !== 'string' || !MAC.test(mac)) return null;
  const want = macOf(secret, result);
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(result, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.v !== 1 || !isText(b.tx, 64) || !(TEST_AGENCY_OUTCOMES as readonly unknown[]).includes(b.outcome)) return null;
  if (typeof b.iat !== 'number' || !Number.isFinite(b.iat)) return null;
  if (b.person !== undefined && typeof b.person !== 'string') return null;
  if (b.birth !== undefined && !(typeof b.birth === 'string' && BIRTH.test(b.birth))) return null;
  const out: TestAgencyResult = { v: 1, tx: b.tx, outcome: b.outcome as TestAgencyOutcome, iat: b.iat };
  if (b.person !== undefined) out.person = b.person as string;
  if (b.birth !== undefined) out.birth = b.birth as string;
  return out;
}
