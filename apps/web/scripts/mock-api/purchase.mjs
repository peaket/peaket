// 가짜 API의 구매 세션(ADR-0225, BUILD_ORDER HOT-353, docs/frontend.md §5.3). 스냅샷에서 받은 클라이언트 임시 공개키로 요청 인증 키를 합의해
// 서명(X-Purchase-Seq·X-Purchase-Mac)을 실제로 확인한다: 브라우저의 서명기가 서버와 같은 식을 쓰는지 화면 흐름에서 본다.
// 서버 키는 RFC 7515 부록 A.3의 공개된 시험 키다(운영·CI에서 쓰지 않는다).
import { createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto';

/** hold 상태 → 401 이름(docs/frontend.md §5.3 '401', HOT-361). seq-reused는 다시 보내도 같아 화면이 끝을 본다 */
const AUTH_FAILURES = { 'session-ended': 'purchase-session-ended', 'signature-invalid': 'purchase-signature-invalid', 'admission-invalid': 'admission-token-invalid', 'seq-reused': 'purchase-seq-reused' };
const SERVER_JWK = { kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0', d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI' };
const serverKey = createPrivateKey({ key: SERVER_JWK, format: 'jwk' });

const HOLD_MS = 7 * 60_000;

/** 입장 토큰 본문의 jti(서명은 보지 않는다) */
function jtiOf(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString()).jti;
  } catch {
    return undefined;
  }
}

function requestKey(clientKeyB64, jti) {
  const point = Buffer.from(clientKeyB64, 'base64url');
  if (point.length !== 65) return undefined;
  const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') }, format: 'jwk' });
  return Buffer.from(hkdfSync('sha256', diffieHellman({ privateKey: serverKey, publicKey: pub }), Buffer.from(jti, 'utf8'), Buffer.from('PEAKET-purchase-v1', 'utf8'), 32));
}

const readRaw = (req) =>
  new Promise((ok, no) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => ok(Buffer.concat(parts)));
    req.on('error', no);
  });

/** 첫 사용 표시와 일련번호를 입장 토큰마다 둔다 */
export function createPurchaseMock({ now, state }) {
  /** token → { clientKey, seq } */
  const sessions = new Map();
  /** holdId → 홀드 응답(주문·다시 읽기) */
  const holds = new Map();
  /** 멱등 키 → 주문 */
  const orders = new Map();
  /** 접수한 주문 → { at, pg } */
  const accepted = new Map();

  /** 스냅샷을 연 입장 토큰의 임시 공개키를 둔다. 처음이고 키가 없으면 false */
  function open(token, clientKey) {
    if (sessions.has(token)) return true;
    if (!clientKey) return false;
    sessions.set(token, { clientKey, seq: 0 });
    return true;
  }

  /** 서명을 확인한다. 틀리면 Problem 이름 */
  function verify(req, pathAndQuery, raw) {
    const token = req.headers['x-admission-token'];
    const session = sessions.get(token);
    if (!token || !session) return 'purchase-session-ended';
    const seq = Number(req.headers['x-purchase-seq']);
    const mac = String(req.headers['x-purchase-mac'] ?? '');
    const jti = jtiOf(token);
    if (!Number.isSafeInteger(seq) || seq < 1 || !mac || !jti) return 'purchase-signature-invalid';
    const key = requestKey(session.clientKey, jti);
    if (!key) return 'purchase-signature-invalid';
    const hash = createHash('sha256').update(raw).digest('base64url');
    const want = createHmac('sha256', key).update(`${req.method}\n${pathAndQuery}\n${seq}\n${hash}`, 'utf8').digest();
    const got = Buffer.from(mac, 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return 'purchase-signature-invalid';
    if (seq <= session.seq) return 'purchase-seq-reused';
    session.seq = seq;
    return undefined;
  }

  const seatOf = (id) => {
    const [sec, row, n] = id.split('-');
    return { seatId: id, label: `${sec}구역 ${row}열 ${n}번`, tierId: sec === 'B' ? 'tier-r' : sec === 'D' || sec === 'F' ? 'tier-a' : 'tier-s', price: 110_000 };
  };

  return {
    open,
    /** 처리했으면 true */
    handle(req, p, url, io) {
      const readHold = /^\/v1\/holds\/([^/]+)$/.exec(p);
      if (readHold && req.method === 'GET') {
        const found = holds.get(readHold[1]);
        if (!sessions.get(req.headers['x-admission-token'])) return (io.problem(401, 'purchase-session-ended', '예매 시간이 끝났습니다'), true);
        if (!found || Date.parse(found.expiresAt) <= now()) return (io.problem(404, 'not-found', '찾을 수 없습니다'), true);
        return (io.send(200, found), true);
      }
      const acceptance = /^\/v1\/orders\/([^/]+)\/payment-acceptance$/.exec(p);
      if (acceptance && req.method === 'POST') {
        const { send, problem } = io;
        void (async () => {
          const raw = await readRaw(req);
          const bad = verify(req, p + url.search, raw);
          if (bad) return problem(401, bad, '요청 서명을 확인하지 못했습니다');
          const body = JSON.parse(raw.toString('utf8') || 'null');
          const orderId = acceptance[1];
          const order = [...orders.values()].find((o) => o.order.orderId === orderId)?.order;
          const mode = state.accept;
          if (!order) return problem(404, 'not-found', '찾을 수 없습니다');
          if (accepted.has(orderId)) return problem(409, 'payment-already-accepted', '이미 접수했습니다');
          if (mode === 'mismatch' || (body?.pg !== 'PORTONE' && body?.amount !== order.amount)) return problem(400, 'invalid-request', '금액이 맞지 않습니다');
          if (mode === 'already') return problem(409, 'payment-already-accepted', '이미 접수했습니다');
          if (mode === 'attempt') return problem(409, 'payment-attempt-mismatch', '결제 시도가 맞지 않습니다');
          if (mode === 'expired') return problem(409, 'order-expired', '주문이 끝났습니다');
          if (mode === 'down') return problem(503, 'internal', '잠시 후 다시 시도해 주세요', { 'retry-after': '1' });
          accepted.set(orderId, { at: now(), pg: body?.pg ?? 'TOSS' });
          return send(202, { orderId, status: 'ACCEPTED' });
        })().catch(() => io.problem(500, 'internal', '오류'));
        return true;
      }
      if (p === '/v1/orders' && req.method === 'POST') {
        const { send, problem } = io;
        void (async () => {
          const raw = await readRaw(req);
          const bad = verify(req, p + url.search, raw);
          if (bad) return problem(401, bad, '요청 서명을 확인하지 못했습니다');
          const body = JSON.parse(raw.toString('utf8') || 'null');
          const key = String(req.headers['idempotency-key'] ?? '');
          if (!key) return problem(400, 'invalid-request', '멱등 키가 없습니다');
          const seen = orders.get(key);
          if (seen) return seen.body === raw.toString('utf8') ? send(201, seen.order) : problem(422, 'idempotency-key-reused', '같은 키로 다른 요청을 보냈습니다');
          const mode = state.order;
          const held = holds.get(body?.holdId);
          if (mode === 'hold-gone' || !held) return problem(404, 'not-found', '찾을 수 없습니다');
          if (body?.consents?.provisionToSeller !== true || body?.consents?.salesTerms !== true) return problem(422, 'consent-required', '동의가 필요합니다');
          if (mode === 'consent-outdated' || body?.consents?.consentVersion !== '2026-10-30') return problem(422, 'consent-version-outdated', '동의 문안이 바뀌었습니다');
          if (mode === 'no-id') return problem(403, 'identity-verification-required', '본인확인이 필요합니다');
          if (mode === 'restricted') return problem(403, 'booking-restricted', '예매가 제한되어 있습니다');
          if (mode === 'other-tab') return problem(409, 'hold-already-ordered', '이미 주문을 만들었습니다');
          if (mode === 'paused') return problem(423, 'sale-paused', '판매가 잠시 멈췄습니다');
          if (mode === 'sale-ended') return problem(410, 'sale-ended', '판매가 끝났습니다');
          if (mode === 'down') return problem(503, 'internal', '잠시 후 다시 시도해 주세요', { 'retry-after': '1' });
          if (AUTH_FAILURES[mode]) return problem(401, AUTH_FAILURES[mode], '구매 세션을 확인하지 못했습니다');
          const order = { orderId: randomUUID(), amount: held.totalAmount, status: 'CREATED', items: held.seats };
          orders.set(key, { order, body: raw.toString('utf8') });
          return send(201, order);
        })().catch(() => io.problem(500, 'internal', '오류'));
        return true;
      }
      const hold = /^\/v1\/events\/([^/]+)\/holds$/.exec(p);
      const leave = /^\/v1\/events\/([^/]+)\/purchase-session$/.exec(p);
      if (!(hold && req.method === 'POST') && !(leave && req.method === 'DELETE')) return false;
      const { send, problem } = io;
      void (async () => {
        const raw = await readRaw(req);
        const pq = url.pathname + url.search;
        const token = req.headers['x-admission-token'];
        // 자동 배정 공연은 첫 홀드가 입장 토큰의 첫 사용이다(스냅샷을 받지 않는다)
        let body = null;
        try {
          body = raw.length ? JSON.parse(raw.toString('utf8')) : null;
        } catch {
          return problem(400, 'invalid-request', '요청 본문이 틀렸습니다');
        }
        if (hold && body?.auto && body.clientEphemeralPublicKey) open(token, body.clientEphemeralPublicKey);
        const bad = verify(req, pq, raw);
        if (bad) return problem(401, bad, '요청 서명을 확인하지 못했습니다');
        if (leave) return send(204, undefined);
        const mode = state.hold;
        if (body?.auto && (mode === 'auto-unsupported' || mode === 'normal')) return problem(400, 'auto-assign-not-supported', '자동 배정을 아직 쓸 수 없습니다');
        if (body?.auto && mode === 'no-match') return problem(409, 'manual-selection-required', '희망 조건에 맞는 좌석이 없습니다');
        if (AUTH_FAILURES[mode]) return problem(401, AUTH_FAILURES[mode], '구매 세션을 확인하지 못했습니다');
        if (mode === 'race') return problem(409, 'seat-already-held', '이미 선택된 좌석입니다', {}, { suggestedSeats: ['A-5-5', 'A-5-6'] });
        if (mode === 'recent') return problem(409, 'seat-recently-released', '방금 놓은 좌석입니다', {}, { recentlyReleasedSeats: body?.seatIds ?? [], reholdAvailableAt: new Date(now() + 30_000).toISOString() });
        if (mode === 'limit') return problem(422, 'purchase-limit-exceeded', '구매 한도를 넘었습니다');
        if (mode === 'paused') return problem(423, 'sale-paused', '판매가 잠시 멈췄습니다');
        if (mode === 'ended') return problem(410, 'sale-ended', '판매가 끝났습니다');
        if (mode === 'down') return problem(503, 'seat-store-unavailable', '잠시 후 다시 시도해 주세요', { 'retry-after': '1' });
        const seatIds = body?.auto ? ['B-1-3', 'B-1-4'] : (body?.seatIds ?? []);
        const seats = seatIds.map(seatOf);
        const created = { holdId: randomUUID(), seatIds, expiresAt: new Date(now() + HOLD_MS).toISOString(), extendable: true, fencingToken: 1, seats, totalAmount: seats.reduce((n, s) => n + s.price, 0), ...(body?.auto ? { assignResult: 'FIRST' } : {}) };
        holds.set(created.holdId, created);
        return send(201, created);
      })().catch(() => problem(500, 'internal', '오류'));
      return true;
    },
  };
}
