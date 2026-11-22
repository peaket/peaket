// 가짜 API의 입장용 휴대폰 등록(POST /v1/tickets/{ticketId}/device-keys, offline-gate §2 '서버 등록 잇기'·'같은 키 다시 등록', ADR-0336).
// 월렛이 서버 등록을 늘 부르게 되어(BAT-350), 가짜 API를 쓰는 개발 서버·브라우저 확인에서 등록이 404(거절 → 키 지움)로 끝나지 않게 둔다.
// - 받은 P-256 공개키 JWK에서 keyId(SPKI SHA-256 앞 8바이트, base64url)를 node:crypto로 계산해 201 `{keyId}`로 답한다(ticket-svc와 같은 식).
// - 같은 티켓의 지금 키와 keyId가 같으면 바꾸지 않고 201, 다른 키면 403 reissue-required(입장 시작 전 재발급, ticket-svc와 같은 이름, ADR-0363 결정 2).
//   X-Reauth-Token을 실은 REISSUE·ISSUE는 재인증을 지난 것으로 보고 받는다(가짜 API는 토큰을 확인하지 않는다). 그 뒤 24시간 안의 두 번째 교체는 429.
// - 상태 바꾸기 deviceKey=normal|mismatch|down|reauth|reissue|booth|not-found|invalid(mismatch는 다른 keyId로 201, down은 503, reauth는 403 reauth-required,
//   reissue는 403 reissue-required, booth는 403 reissue-at-booth, not-found는 404, invalid는 422 invalid-device-key). deviceKeyReset=1은 등록한 키를 모두 잊는다.
//   비로그인(fan=guest)은 401
import { createHash, createPublicKey } from 'node:crypto';

/** 계약이 받는 칸(openapi createTicketDeviceKey). 그 밖의 칸(개인키 d 포함)이 있으면 400 */
const BODY_FIELDS = new Set(['publicKeyJwk', 'reason', 'boothRequestId']);
const JWK_FIELDS = new Set(['kty', 'crv', 'x', 'y', 'ext', 'key_ops', 'alg']);
const REASONS = new Set(['ISSUE', 'REISSUE', 'TRANSFER', 'BOOTH']);
const COORD = /^[A-Za-z0-9_-]{43}$/;
const PATH = /^\/v1\/tickets\/([^/]+)\/device-keys$/;

/** 계약 모양의 공개키 JWK인가(정의 밖 칸·꼴이 틀리면 false) */
function contractJwk(jwk) {
  if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) return false;
  if (Object.keys(jwk).some((k) => !JWK_FIELDS.has(k))) return false;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !COORD.test(jwk.x ?? '') || !COORD.test(jwk.y ?? '')) return false;
  if (jwk.ext !== undefined && typeof jwk.ext !== 'boolean') return false;
  if (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || jwk.key_ops.length > 2 || jwk.key_ops.some((o) => o !== 'verify'))) return false;
  if (jwk.alg !== undefined && jwk.alg !== 'ES256') return false;
  return true;
}

/**
 * P-256 공개키 JWK의 keyId(공개키 SPKI DER의 SHA-256 앞 8바이트, base64url 11자). 곡선 밖의 점이면 undefined
 * @param {{ x: string; y: string }} jwk
 */
export function deviceKeyIdOf(jwk) {
  try {
    const spki = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' }).export({ type: 'spki', format: 'der' });
    return createHash('sha256').update(spki).digest().subarray(0, 8).toString('base64url');
  } catch {
    return undefined;
  }
}

/** keyId의 첫 바이트를 바꾼 값(deviceKey=mismatch) */
function otherKeyId(keyId) {
  const b = Buffer.from(keyId, 'base64url');
  b[0] ^= 0xff;
  return b.toString('base64url');
}

/** @param {{ state: Record<string, unknown> }} o */
export function createTicketsMock({ state }) {
  /** 티켓 ID → 지금 유효 keyId */
  const active = new Map();
  /** 티켓 ID → 재인증 뒤 교체한 횟수(24시간 한도 흉내, 가짜 API는 시각을 보지 않는다) */
  const rotated = new Map();
  return {
    reset() {
      active.clear();
      rotated.clear();
    },
    /**
     * 처리했으면 true
     * @param {import('node:http').IncomingMessage} req
     * @param {string} p
     * @param {{ send: Function; problem: Function; readJson: (req: import('node:http').IncomingMessage) => Promise<unknown>; badRequest: () => void; unauthorized: () => void }} io
     */
    handle(req, p, io) {
      const m = PATH.exec(p);
      if (!m || req.method !== 'POST') return false;
      if (state.fan === 'guest') return (io.unauthorized(), true);
      const ticketId = m[1];
      void io.readJson(req).then((b) => {
        if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => !BODY_FIELDS.has(k)) || !REASONS.has(b.reason) || !contractJwk(b.publicKeyJwk)) return io.badRequest();
        const mode = state.deviceKey ?? 'normal';
        if (mode === 'down') return io.problem(503, 'dependency-unavailable', '잠시 후 다시 시도해 주세요', { 'retry-after': '1' });
        if (mode === 'reauth') return io.problem(403, 'reauth-required', '다시 인증해 주세요');
        if (mode === 'reissue') return io.problem(403, 'reissue-required', '이 티켓은 다른 기기에 입장 키가 있습니다. 다시 로그인한 뒤 이 휴대폰으로 받을 수 있습니다');
        if (mode === 'booth') return io.problem(403, 'reissue-at-booth', '입장이 시작되어 현장 부스에서만 다시 받을 수 있습니다');
        if (mode === 'not-found') return io.problem(404, 'not-found', '찾을 수 없습니다');
        const keyId = deviceKeyIdOf(b.publicKeyJwk);
        if (mode === 'invalid' || !keyId) return io.problem(422, 'invalid-device-key', '기기 공개키가 P-256 곡선 위의 점이 아닙니다');
        if (b.reason === 'BOOTH') return io.problem(403, 'booth-not-authorized', '부스 재발급 허용이 없거나 10분이 지났습니다');
        const current = active.get(ticketId);
        const reauthed = typeof req.headers['x-reauth-token'] === 'string' && req.headers['x-reauth-token'] !== '';
        // 같은 키 다시 등록은 바꾸지 않고 201, 다른 키는 재인증 뒤 다시 받는다(403 reissue-required, 토큰을 실으면 교체)
        if (current !== undefined && current !== keyId) {
          if (!reauthed) return io.problem(403, 'reissue-required', '이 티켓은 다른 기기에 입장 키가 있습니다. 다시 로그인한 뒤 이 휴대폰으로 받을 수 있습니다');
          if ((rotated.get(ticketId) ?? 0) >= 1) return io.problem(429, 'too-many-requests', '24시간 안에 이미 다시 받았습니다', { 'retry-after': '86400' });
          rotated.set(ticketId, (rotated.get(ticketId) ?? 0) + 1);
        }
        active.set(ticketId, keyId);
        return io.send(201, { keyId: mode === 'mismatch' ? otherKeyId(keyId) : keyId });
      });
      return true;
    },
  };
}
