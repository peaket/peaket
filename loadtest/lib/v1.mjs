// v1 경로의 가상 사용자·좌석·일련번호(docs/verification.md §3.9 'v1 경로', BUILD_ORDER PRF-215). k6 시나리오·실행 도구·Node 시험이 같은 파일을 읽는다(node: 모듈을 쓰지 않는다).
// - 신원: 게이트웨이가 없어 k6가 신원 머리를 넣는다(§3.8 '게이트웨이 없음'). 계정·세션 ID는 UUID 꼴이어야 한다(purchase DB의 uuid 칸)
// - 좌석: v0와 같은 격자(lib/seats.mjs)의 k번째 좌석을 UUID `00000000-0000-4000-8000-<k 16진 12자리>`로 쓴다(seat_sale·seat_hold의 seat_id는 uuid)
// - 일련번호: 구매 세션 하나를 여러 가상 사용자(k6 VU)가 차례로 쓰므로 시각 기반으로 늘 커지게 고른다(아래 nextPurchaseSeq)
import { resultOf } from './records.mjs';
import { assertRunTag } from './users.mjs';
import { seatCount } from './seats.mjs';

/**
 * 결제 결과(PaymentStatus, docs/api/openapi.yaml)의 끝 상태: 확정·실패·입금 대기·보상. 결과 모름(UNKNOWN)·접수·예약·승인(발권 중)은 거쳐 가는 상태라
 * 끝 상태까지 더 묻는다(docs/verification.md §3.9 'K7의 결제 확정 시간', 재확인 리뷰 3)
 */
export const PAYMENT_TERMINAL = Object.freeze(['CONFIRMED', 'FAILED', 'AWAITING_DEPOSIT', 'COMPENSATED']);

/**
 * 사전 검증 결과: 201이고 토큰이 있어야 ok다. 201인데 토큰이 없으면 결과를 모른다(재확인 리뷰 6). 그 밖은 resultOf와 같다
 * @param {number} status @param {unknown} token
 */
export function preverifyResult(status, token) {
  const r = resultOf(status, [201]);
  return r === 'ok' && typeof token !== 'string' ? 'unknown' : r;
}

const hex = (n, width) => n.toString(16).padStart(width, '0');
const userIndex = (i) => {
  if (!Number.isSafeInteger(i) || i < 0 || i > 0xffffffff) throw new RangeError(`가상 사용자 번호는 0~2^32−1 정수다: ${i}`);
  return i;
};

/** 실행 꼬리표의 16진 8자리(영소문자·숫자 1~16자를 FNV-1a 32비트로) */
export function runTagHex(runTag) {
  let h = 0x811c9dc5;
  for (const ch of assertRunTag(runTag)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return hex(h, 8);
}

/** 가상 사용자 i의 계정 ID(UUID v4 꼴, 실행마다 다르다): <꼬리표 8>-<i 상위 4>-4<i 하위 3>-a000-<kind 12> */
function idOf(runTag, i, kind) {
  userIndex(i);
  return `${runTagHex(runTag)}-${hex(i >>> 12, 4)}-4${hex(i & 0xfff, 3)}-a000-${kind}`;
}
export const v1AccountId = (runTag, i) => idOf(runTag, i, '000000000001');
export const v1SessionId = (runTag, i) => idOf(runTag, i, '000000000002');
/** 사람 식별값(대기열 진입·입장 확정에 꼭 있다. 축소 운영의 사람별 한도를 피하려고 가상 사용자마다 다르다) */
export const v1Pid = (runTag, i) => `pid-lt-${assertRunTag(runTag)}-${userIndex(i)}`;

/**
 * 게이트웨이가 넣는 신원 머리(packages/platform/src/auth.ts identityOf): 계정·로그인 세션·대상(fan)·권한(ticket:buy)·사람 식별값.
 * json이면 content-type도 단다
 * @param {string} runTag @param {number} i @param {{ json?: boolean }} [o]
 */
export function v1Headers(runTag, i, o = {}) {
  return {
    'x-user-id': v1AccountId(runTag, i),
    'x-session-id': v1SessionId(runTag, i),
    'x-user-aud': 'fan',
    'x-user-scope': 'ticket:buy',
    'x-user-pid': v1Pid(runTag, i),
    ...(o.json ? { 'content-type': 'application/json' } : {}),
  };
}

/** 좌석 번호 k의 UUID */
export function v1SeatUuid(k) {
  if (!Number.isSafeInteger(k) || k < 0 || k >= 2 ** 48) throw new RangeError(`좌석 번호는 0 이상 정수다: ${k}`);
  return `00000000-0000-4000-8000-${hex(k, 12)}`;
}

/** 격자의 좌석 ID(`<구역>-<열>-<번호>`, lib/seats.mjs)를 그 좌석의 번호로. 격자에 없으면 RangeError */
export function seatIndexOf(grid, seatId) {
  const m = /^([A-Za-z0-9]{1,8})-(\d+)-(\d+)$/.exec(String(seatId));
  const s = m ? grid.sections.indexOf(m[1]) : -1;
  const r = m ? Number(m[2]) - 1 : -1;
  const c = m ? Number(m[3]) - 1 : -1;
  if (s < 0 || r < 0 || r >= grid.rows || c < 0 || c >= grid.perRow) throw new RangeError(`격자에 없는 좌석: ${seatId}`);
  return s * grid.rows * grid.perRow + r * grid.perRow + c;
}

/** v0 좌석 ID 목록을 v1 좌석 UUID 목록으로 */
export const v1SeatIds = (grid, ids) => ids.map((id) => v1SeatUuid(seatIndexOf(grid, id)));

/**
 * 시험 회차의 좌석맵 판 파일(purchase-svc PEAKET_SEATMAP_DIR/{eventId}.json, docs/features/seat-hold.md §2 '운영 좌석맵 판').
 * 격자의 구역마다 구역 하나(등급 R 하나), 좌석은 번호 차례의 UUID. 판매 종료 시각은 대기열 일정의 공연 시작 − 24시간과 같아야 한다
 * @param {{ sections: string[], rows: number, perRow: number }} grid
 * @param {{ perAccountLimit: number, saleEndsAtMs: number, price: number, layoutVersion: number }} o
 */
export function v1SeatMap(grid, o) {
  seatCount(grid);
  if (!Number.isInteger(o.perAccountLimit) || o.perAccountLimit < 1 || o.perAccountLimit > 4) throw new RangeError('한 사람 상한은 1~4다');
  if (!Number.isSafeInteger(o.price) || o.price < 1) throw new RangeError('가격은 1 이상 정수다');
  const per = grid.rows * grid.perRow;
  return {
    perAccountLimit: o.perAccountLimit,
    saleEndsAt: new Date(o.saleEndsAtMs).toISOString(),
    tierPrices: { R: o.price },
    orderName: '부하 시험 회차',
    layout: {
      layoutVersion: o.layoutVersion,
      sections: grid.sections.map((name, s) => ({
        sectionId: `SEC-${name}`,
        tierId: 'R',
        seatIndexRange: { from: s * per, to: s * per + per - 1 },
        seats: Array.from({ length: per }, (_, j) => ({ seatId: v1SeatUuid(s * per + j), index: s * per + j })),
      })),
    },
  };
}

/**
 * 다음 구매 요청 일련번호: 지금 시각(ms) × 1,000과 지난 번호 + 1 가운데 큰 것. 같은 구매 세션을 여러 VU가 차례로 써도(예열 → 본구간) 앞 VU의 번호보다 크고,
 * 한 VU 안에서는 늘 커진다(서버는 지난 번호보다 큰 번호만 받고 사이가 비는 것은 받는다). 2^53 − 1을 넘으면 RangeError
 * @param {number} last @param {number} nowMs
 */
export function nextPurchaseSeq(last, nowMs) {
  const next = Math.max(last + 1, Math.floor(nowMs) * 1000);
  if (!Number.isSafeInteger(next)) throw new RangeError('일련번호가 2^53 − 1을 넘는다');
  return next;
}

/**
 * VU 하나가 맡는 가상 사용자(같은 구매 세션을 두 VU가 동시에 쓰지 않게): 사용자 u는 u mod groups == vu mod groups인 VU만 쓴다.
 * groups는 min(사용자 수, VU 수)다. 그 무리에서 k번째 사람(0 ≤ k)을 돌려주고, 무리에 사람이 없으면 -1
 * @param {number} users @param {number} groups @param {number} vu VU 번호(1부터) @param {number} u1 [0, 1) 난수
 */
export function ownedUser(users, groups, vu, u1) {
  if (!Number.isSafeInteger(users) || users < 1 || !Number.isSafeInteger(groups) || groups < 1) throw new RangeError('사용자 수·무리 수는 1 이상 정수다');
  const g = vu % groups;
  if (g >= users) return -1;
  const size = Math.floor((users - 1 - g) / groups) + 1;
  return g + groups * Math.min(size - 1, Math.floor(u1 * size));
}
