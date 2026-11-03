// 가상 사용자(docs/verification.md §3.9 '신원'): 실행마다 만든 시험 계정 가명과 측정용 대역의 IP, 입구로 보내는 머리.

/** 가상 사용자 수 상한(198.18.0.0/15의 주소 수) */
export const MAX_USERS = 131072;
/** 입구의 액세스 토큰 쿠키 이름(services/v0-monolith/src/gateway/token.ts) */
export const ACCESS_COOKIE = '__Secure-peaket_at';

const RUN_TAG = /^[a-z0-9]{1,16}$/;

const isIpv4 = (ip) => {
  const p = ip.split('.');
  return p.length === 4 && p.every((x) => /^(0|[1-9]\d{0,2})$/.test(x) && Number(x) <= 255);
};

const userIndex = (i) => {
  if (!Number.isInteger(i) || i < 0 || i >= MAX_USERS) throw new RangeError(`가상 사용자 번호는 0 이상 ${MAX_USERS} 미만 정수다: ${i}`);
  return i;
};

/**
 * i번째 가상 사용자의 IP(198.18.0.0/15, RFC 2544 측정용 대역). 0 ≤ i < MAX_USERS인 정수가 아니면 RangeError.
 * i=0 → '198.18.0.0', i=257 → '198.18.1.1', i=65536 → '198.19.0.0', i=131071 → '198.19.255.255'
 * @param {number} i
 * @returns {string}
 */
export function userIp(i) {
  userIndex(i);
  return `198.${18 + (i >> 16)}.${(i >> 8) & 255}.${i & 255}`;
}

/**
 * 실행 꼬리표 검사: 영소문자·숫자 1~16자(`^[a-z0-9]{1,16}$`)가 아니면 Error. 맞으면 그대로 돌려준다
 * @param {string} tag
 * @returns {string}
 */
export function assertRunTag(tag) {
  if (typeof tag !== 'string' || !RUN_TAG.test(tag)) throw new Error('실행 꼬리표는 영소문자·숫자 1~16자다');
  return tag;
}

/**
 * 가상 사용자 i의 시험 계정 가명 `acc-lt-<runTag>-<i>`. runTag는 assertRunTag, i는 0 ≤ i < MAX_USERS 정수(아니면 RangeError)
 * @param {string} runTag
 * @param {number} i
 */
export function accountRef(runTag, i) {
  return `acc-lt-${assertRunTag(runTag)}-${userIndex(i)}`;
}

/** 사람 식별값 `pid-lt-<runTag>-<i>`(검사는 accountRef와 같다) */
export function pidOf(runTag, i) {
  return `pid-lt-${assertRunTag(runTag)}-${userIndex(i)}`;
}

/** 세션 ID `sid-lt-<runTag>-<i>`(검사는 accountRef와 같다) */
export function sidOf(runTag, i) {
  return `sid-lt-${assertRunTag(runTag)}-${userIndex(i)}`;
}

/**
 * 입구로 보내는 머리. 늘 `cookie: __Secure-peaket_at=<token>`과 `x-forwarded-for: <ip>`.
 * write가 참이면 `origin: <origin>`(쿠키로 하는 쓰기는 Origin이 있어야 한다), json이 참이면 `content-type: application/json`.
 * write가 거짓이면 origin을 주어도 싣지 않는다. 다음이면 Error(메시지에 토큰을 싣지 않는다): token이 문자열이 아니거나 비었거나 공백 글자(정규식 \s)·`;`·`,`가 있음,
 * ip가 점 넷 IPv4(`a.b.c.d`, 각 0~255)가 아님, write인데 origin이 비었거나 없음
 * @param {{ token: string, ip: string, origin?: string, write?: boolean, json?: boolean }} o
 * @returns {Record<string, string>}
 */
export function fanHeaders(o) {
  if (typeof o.token !== 'string' || o.token.length === 0 || /[\s;,]/.test(o.token)) throw new Error('토큰이 비었거나 쿠키에 넣을 수 없는 글자가 있다');
  if (typeof o.ip !== 'string' || !isIpv4(o.ip)) throw new Error('가상 사용자 IP는 점 넷 IPv4다');
  const h = { cookie: `${ACCESS_COOKIE}=${o.token}`, 'x-forwarded-for': o.ip };
  if (o.write) {
    if (typeof o.origin !== 'string' || o.origin.length === 0) throw new Error('쿠키로 하는 쓰기에는 Origin이 있어야 한다');
    h.origin = o.origin;
  }
  if (o.json) h['content-type'] = 'application/json';
  return h;
}
