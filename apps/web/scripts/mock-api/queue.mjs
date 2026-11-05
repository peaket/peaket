// 가짜 API의 대기열(openapi /v1/queues/{eventId}/*, ADR-0207). 오픈 뒤 경로만 흉내 낸다: 진입·묶음 결과 파일·대기 상태 파일·입장 확정·대기 취소.
// queue-svc를 단순하게 흉내 낸 모형이다: 진입한 차례대로 순번을 주고, serving은 판매 중일 때만 queueRate(1초에 지나는 번호)로 나아간다.
// 운영·CI에서는 쓰지 않는다(ADR-0199 결정 2). 상태 바꾸기는 /__mock/state의 queue* 칸이다(scripts/mock-api.mjs 머리 주석).
import { createHash, randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEGMENT = 1000;
/** 마지막 구간 뒤 이만큼보다 먼 구간 파일은 404(queue-admission §4) */
const FAR_SEGMENTS = 100;
const SALE = { 'on-sale': 'ON_SALE', paused: 'PAUSED', 'all-held': 'ALL_HELD', 'sold-out': 'SOLD_OUT', ended: 'ENDED' };
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** 상태 바꾸기의 대기열 칸 기본값 */
export const QUEUE_DEFAULTS = Object.freeze({
  queue: 'on-sale',
  queueEntry: 'normal',
  queueAdmit: 'normal',
  queueAhead: '30',
  queueRate: '2',
  queueRemoved: '0',
  queueBanner: '',
  queueSeats: '',
});

/**
 * @param {{ now: () => number, state: Record<string, string> }} o
 */
export function createQueueMock({ now, state }) {
  /** 회차 → { nextSeq, serving(소수), lastT, tickets: Map(대기표 → {seq, admitted, soonShown}), entries: Map(요청 ID → {token, seq?, publishAt?, ticket?}), once: Set } */
  const events = new Map();
  const ev = (id) => {
    let e = events.get(id);
    if (!e) {
      e = { nextSeq: 1001, serving: null, lastT: now(), tickets: new Map(), entries: new Map(), once: new Set() };
      events.set(id, e);
    }
    return e;
  };
  const num = (k) => {
    const v = Number(state[k]);
    return Number.isFinite(v) && v >= 0 ? v : Number(QUEUE_DEFAULTS[k]);
  };
  const sale = () => SALE[state.queue] ?? 'ON_SALE';
  /** 판매 중일 때만 serving이 나아간다(일시정지·일시 매진은 멈춤) */
  const advance = (e) => {
    const t = now();
    if (e.serving === null) e.serving = e.nextSeq - 1 - num('queueAhead');
    if (sale() === 'ON_SALE') e.serving += (num('queueRate') * (t - e.lastT)) / 1000;
    e.lastT = t;
    return Math.max(0, Math.floor(e.serving));
  };
  const issue = (e, seq) => {
    const ticket = `qt.${randomUUID()}`;
    e.tickets.set(ticket, { seq, admitted: false, soonShown: false });
    return ticket;
  };
  const ticketBody = (ticket, seq, verification) => ({
    queueTicket: ticket,
    seq,
    generation: 1,
    segment: Math.floor((seq - 1) / SEGMENT),
    ...(verification ? { verification: 'REQUIRED', verificationReason: 'RAPID_REQUESTS' } : { verificationReason: null }),
    serverTimeMs: now(),
  });

  /** 처리했으면 true. send(status, body, type?, extra?)·problem(status, name, title, extra?)는 가짜 API의 답하기 함수 */
  return {
    reset() {
      events.clear();
    },
    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {string} p 경로
     * @param {{ send: Function, problem: Function, readJson: (req: any) => Promise<any>, badRequest: () => void }} io
     */
    handle(req, p, io) {
      const m = /^\/v1\/queues\/([A-Za-z0-9-]{1,64})\/(entries|entries\/me|admission|segment-states\/(\d{1,6})\.json|batch-results\/([0-9a-f]{3})\.json)$/.exec(p);
      if (!m) return false;
      const e = ev(m[1]);
      const [, eventId, kind, segment, prefix] = m;
      const { send, problem } = io;

      if (kind === 'entries' && req.method === 'POST') {
        void io.readJson(req).then((b) => {
          const keys = b && typeof b === 'object' ? Object.keys(b) : [];
          if (!b || typeof b.preverifyToken !== 'string' || b.preverifyToken.length === 0 || keys.some((k) => !['preverifyToken', 'deviceId', 'entryRequestId'].includes(k)) || (b.entryRequestId !== undefined && !UUID.test(b.entryRequestId))) return io.badRequest();
          const id = b.entryRequestId ?? randomUUID();
          const mode = state.queueEntry;
          // 혼잡·장애는 요청 ID마다 한 번만(다시 보내면 지나간다)
          if ((mode === 'busy' || mode === 'down') && !e.once.has(`entry:${id}`)) {
            e.once.add(`entry:${id}`);
            return mode === 'busy'
              ? problem(429, 'server-busy', '요청이 많아 잠시 기다려야 합니다', { 'retry-after': '2' })
              : problem(503, 'dependency-unavailable', '잠시 후 다시 시도해 주세요', { 'retry-after': '1' });
          }
          if (mode === 'other-device') return problem(409, 'already-waiting', '다른 기기에서 이미 대기 중입니다');
          if (mode === 'already-admitted') return problem(409, 'already-admitted', '이미 입장했습니다');
          if (mode === 'not-open') return problem(409, 'queue-not-open', '아직 대기열이 열리지 않았습니다');
          if (mode === 'preverify-invalid') return problem(403, 'preverify-invalid', '사전 확인이 만료됐습니다');
          if (mode === 'sold-out') return problem(410, 'sold-out', '매진입니다');
          if (mode === 'ended') return problem(410, 'sale-ended', '판매가 끝났습니다');
          advance(e);
          const known = e.entries.get(id);
          if (known?.ticket) return send(201, ticketBody(known.ticket, known.seq, false));
          if (mode === 'batching' || known?.publishAt !== undefined) {
            const entry = known ?? { token: b.preverifyToken, publishAt: now() + 3000, seq: e.nextSeq++ };
            e.entries.set(id, entry);
            if (now() < entry.publishAt) {
              return send(202, { entryRequestId: id, resultPath: `/v1/queues/${eventId}/batch-results/${sha(entry.token).slice(0, 3)}.json`, resultAt: new Date(entry.publishAt).toISOString(), spreadSec: 2, serverTimeMs: now() });
            }
            entry.ticket = issue(e, entry.seq);
            return send(201, ticketBody(entry.ticket, entry.seq, false));
          }
          const seq = e.nextSeq++;
          const ticket = issue(e, seq);
          e.entries.set(id, { token: b.preverifyToken, seq, ticket });
          return send(201, ticketBody(ticket, seq, mode === 'verify'));
        });
        return true;
      }

      if (kind === 'entries/me' && req.method === 'DELETE') {
        e.tickets.clear();
        e.entries.clear();
        send(204, undefined);
        return true;
      }

      if (prefix && req.method === 'GET') {
        const table = {};
        for (const entry of e.entries.values()) {
          if (entry.publishAt === undefined || now() < entry.publishAt) continue;
          const h = sha(entry.token);
          if (h.startsWith(prefix)) table[h] = entry.seq;
        }
        if (Object.keys(table).length === 0) return problem(404, 'not-found', '아직 결과가 없습니다', { 'cache-control': 'public, max-age=1' }), true;
        send(200, table, undefined, { 'cache-control': 'public, max-age=60' });
        return true;
      }

      if (segment !== undefined && req.method === 'GET') {
        const s = Number(segment);
        const serving = advance(e);
        const last = Math.floor(Math.max(0, e.nextSeq - 2) / SEGMENT);
        if (s > last + FAR_SEGMENTS) return problem(404, 'queue-not-found', '대기열을 찾을 수 없습니다'), true;
        const status = sale();
        // 빠진 번호: 이 구간의 처음부터 queueRemoved개(serving 뒤에 있는 번호만 앞 인원에서 빠진다)
        const bitmap = Buffer.alloc(125);
        const removed = Math.min(num('queueRemoved'), SEGMENT);
        const first = Math.max(serving + 1, s * SEGMENT + 1);
        for (let k = 0; k < removed; k++) {
          const bit = first + k - (s * SEGMENT + 1);
          if (bit >= 0 && bit < SEGMENT) bitmap[bit >> 3] |= 0x80 >> (bit & 7);
        }
        const seats = state.queueSeats === '' || state.queueSeats === undefined ? undefined : num('queueSeats');
        send(
          200,
          {
            serving,
            servingRate: status === 'ON_SALE' ? Math.round(num('queueRate') * 1000) / 1000 : 0,
            saleStatus: status,
            soldOutTiers: [],
            removedUpToServing: 0,
            removedBeforeSegment: 0,
            removedBitmap: bitmap.toString('base64'),
            ...(state.queueBanner ? { banner: state.queueBanner } : {}),
            generatedAtMs: Math.floor(now() / 1000) * 1000,
            pollHintMs: 0,
            ...(seats === undefined ? {} : { remainingSeats: seats, avgTicketsPerOrder: 2 }),
            seatmapLayoutPath: `/v1/events/${eventId}/seatmap-layouts/1.json`,
          },
          undefined,
          { 'cache-control': 'public, max-age=1, stale-while-revalidate=2' },
        );
        return true;
      }

      if (kind === 'admission' && req.method === 'POST') {
        void io.readJson(req).then((b) => {
          const keys = b && typeof b === 'object' ? Object.keys(b) : [];
          if (!b || typeof b.queueTicket !== 'string' || keys.some((k) => !['queueTicket', 'lobbyToken', 'priorityGrantId', 'firstEtaSec', 'firstEtaAtMs'].includes(k))) return io.badRequest();
          const t = e.tickets.get(b.queueTicket);
          if (!t) return problem(403, 'queue-ticket-invalid', '대기표가 맞지 않습니다');
          const mode = state.queueAdmit;
          if (mode === 'unauthorized') return send(401, { type: 'about:blank', title: 'Unauthorized', status: 401 }, 'application/problem+json');
          if (mode === 'restricted') return problem(403, 'booking-restricted', '예매가 제한되어 있습니다');
          if (mode === 'duplicate') return problem(409, 'duplicate-admission', '다른 곳에서 이미 입장했습니다');
          if (mode === 'expired' || mode === 'expired-final') return problem(410, 'queue-ticket-expired', '대기표가 만료됐습니다', {}, { rejoinAllowed: mode === 'expired' });
          if (mode === 'removed') return problem(410, 'queue-ticket-removed', '대기가 취소됐습니다');
          if (mode === 'sold-out') return problem(410, 'sold-out', '매진입니다');
          if (mode === 'ended') return problem(410, 'sale-ended', '판매가 끝났습니다');
          if (mode === 'down') return problem(503, 'dependency-unavailable', '잠시 후 다시 시도해 주세요', { 'retry-after': '1' });
          if (mode === 'verifying') return send(200, { status: 'VERIFYING', verificationReason: 'RAPID_REQUESTS', serverTimeMs: now() });
          // 같은 대기표로 다시 오면(응답을 잃고 다시 보냄) queue-svc처럼 ADMITTED를 다시 준다
          const serving = advance(e);
          if (serving < t.seq) {
            const rate = Math.max(num('queueRate'), 0.001);
            return send(200, { status: 'NOT_YET', retryAfterMs: Math.min(60_000, Math.max(1000, Math.ceil(((t.seq - serving) / rate) * 1000))), serverTimeMs: now() });
          }
          if (mode === 'soon' && !t.soonShown) {
            t.soonShown = true;
            return send(200, { status: 'SOON', retryAfterSeconds: 2, serverTimeMs: now() });
          }
          t.admitted = true;
          e.lastAdmission = b;
          return send(200, {
            status: 'ADMITTED',
            admissionToken: `adm.${randomUUID()}`,
            purchaseSessionExpiresAt: new Date(now() + 45 * 60_000).toISOString(),
            serverEcdhPublicKey: { kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0', kid: 'mock-ecdh-1' },
            seatmapLayoutPath: `/v1/events/${eventId}/seatmap-layouts/1.json`,
            serverTimeMs: now(),
          });
        });
        return true;
      }
      return false;
    },
  };
}
