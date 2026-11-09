// 가짜 API의 대기열(openapi /v1/queues/{eventId}/*, ADR-0207·0208·0211): 사전 검증(공연 상세), 로비 참가·참가 취소·셔플 결과 파일, 진입·묶음 결과 파일·대기 상태 파일·입장 확정·대기 취소.
// queue-svc를 단순하게 흉내 낸 모형이다: 진입한 차례대로 순번을 주고, serving은 판매 중일 때만 queueRate(1초에 지나는 번호)로 나아간다.
// 운영·CI에서는 쓰지 않는다(ADR-0199 결정 2). 상태 바꾸기는 /__mock/state의 queue* 칸이다(scripts/mock-api.mjs 머리 주석).
import { createHash, randomUUID } from 'node:crypto';
import { mockAdmissionToken } from './seatmap.mjs';
import { EMERGENCY_BEACON_HEX, merkleRootHex, recomputeOrder } from '../../src/_pages/shuffle-proof/model/recompute.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEGMENT = 1000;
/** 마지막 구간 뒤 이만큼보다 먼 구간 파일은 404(queue-admission §4) */
const FAR_SEGMENTS = 100;
const SALE = { 'on-sale': 'ON_SALE', paused: 'PAUSED', 'all-held': 'ALL_HELD', 'sold-out': 'SOLD_OUT', ended: 'ENDED' };
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const bytes = (hex) => Buffer.from(hex, 'hex');
const hashBytes = (...parts) => parts.reduce((h, p) => h.update(p), createHash('sha256')).digest('hex');
const seedOf = (name) => sha(`seed-${name}`);
/** drand 서명 자리는 16진 96자다(G1 48바이트, ADR-0239 결정 3) */
const sigOf = (name) => sha(`sig-${name}`).repeat(2).slice(0, 96);
const beaconOf = (name) => hashBytes(bytes(sigOf(name)));
/** queueProof가 normal이 아닐 때 로비 구간의 참가자(토큰 해시). 검증 화면 ⑥에는 SHA-256("mock-proof-1")을 넣는다 */
const PROOF_TOKENS = ['mock-proof-1', 'mock-proof-2', 'mock-proof-3', 'mock-proof-4'].map(sha);
/** 결과 파일을 고정 비콘으로 섞는 상태 */
const NO_BEACON_PROOF = new Set(['emergency', 'disguised', 'invalid-emergency']);

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
  /** 로비 참가: normal|verify|other-device|identity|human-fail|busy|down|unauthorized */
  queueLobby: 'normal',
  /** 셔플 결과 파일: normal(오픈 3초 뒤 게시)|late(43초 뒤)|never|missing(내 참가 토큰이 목록에 없음) */
  queueShuffle: 'normal',
  /** 셔플 검증 정보의 로비 구간 공시(ADR-0239): normal(결과 파일 합성)|matched(⑥ 일치)|emergency(비콘 없이 비상 셔플, ⑥ 주의)|disguised(비상 셔플을 일반으로 위장, ⑥ 차단)|redisclosed(라운드 다시 공시)|invalid-emergency|invalid-redisclosures(읽지 못한 칸) */
  queueProof: 'normal',
  /** 오픈까지 남은 초(공연 공개 요약의 openAt을 지금 + 이 값으로 바꾼다. 빈 값이면 고정 자료 그대로) */
  queueOpenIn: '',
  /** 사전 검증(공연 상세): normal|identity|not-found|down|unauthorized. queue-svc는 사람 확인 실패·위험 판정 장애에도 토큰을 준다(ADR-0211 결정 4) */
  queuePreverify: 'normal',
  /** 매진된 등급 ID(쉼표, 대기 상태 파일 soldOutTiers, 자동 배정 희망 조건 경고, ADR-0212) */
  queueSoldOutTiers: '',
  /** 200 대기 상태 파일에 실을 Retry-After 초(브라우저는 무시해야 한다, FE-T4, ADR-0217). 빈 값이면 싣지 않는다 */
  queueStateRetryAfter: '',
});

/**
 * @param {{ now: () => number, state: Record<string, string>, schedule?: (eventId: string) => ({ openAtMs: number, lobbyOpensAtMs: number | null } | null) }} o
 */
export function createQueueMock({ now, state, schedule = () => null }) {
  /** 회차 → { nextSeq, serving(소수), lastT, tickets: Map(대기표 → {seq, admitted, soonShown}), entries: Map(요청 ID → {token, seq?, publishAt?, ticket?}), once: Set } */
  const events = new Map();
  const ev = (id) => {
    let e = events.get(id);
    if (!e) {
      // tickets에는 대기표와 로비 참가 토큰이 함께 든다(참가 토큰이 대기표 역할, queue-admission §2)
      e = { id, nextSeq: 1001, serving: null, lastT: now(), tickets: new Map(), entries: new Map(), once: new Set(), lobby: null, removed: new Set(), otherCleared: false };
      events.set(id, e);
    }
    return e;
  };
  const num = (k) => {
    const v = Number(state[k]);
    return Number.isFinite(v) && v >= 0 ? v : Number(QUEUE_DEFAULTS[k]);
  };
  const sale = () => SALE[state.queue] ?? 'ON_SALE';
  /** 판매 중이고 오픈이 지났을 때만 serving이 나아간다(일시정지·일시 매진은 멈춤) */
  const advance = (e) => {
    const t = now();
    if (e.serving === null) e.serving = e.nextSeq - 1 - num('queueAhead');
    const s = schedule(e.id);
    if (sale() === 'ON_SALE' && (!s || t >= s.openAtMs)) e.serving += (num('queueRate') * (t - Math.max(e.lastT, s?.openAtMs ?? 0))) / 1000;
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

  /** queueProof가 normal이 아닐 때의 결과: 규격대로 섞은 결과 파일과 머클 루트(재현 코드는 화면의 recompute.ts를 그대로 쓴다) */
  const lobbyWorld = async (eventId) => {
    const sortedTokens = [...PROOF_TOKENS].sort();
    const rootHex = await merkleRootHex(sortedTokens);
    const order = await recomputeOrder({ eventId, seedHex: seedOf('lobby'), beaconHex: NO_BEACON_PROOF.has(state.queueProof) ? EMERGENCY_BEACON_HEX : beaconOf('lobby'), sortedTokens, rootHex });
    return { rootHex, entries: Object.fromEntries(order.map((h, i) => [h, i + 1])) };
  };

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
      const m = /^\/v1\/queues\/([A-Za-z0-9-]{1,64})\/(entries|entries\/me|admission|pre-verifications|lobby-participants|lobby-participants\/me|segment-states\/(\d{1,6})\.json|batch-results\/([0-9a-f]{3})\.json|shuffle-results\/([0-9a-f]{3})\.json|shuffle-proof)$/.exec(p);
      if (!m) return false;
      const e = ev(m[1]);
      const [, eventId, kind, segment, prefix, shufflePrefix] = m;
      const { send, problem } = io;
      const sched = schedule(eventId);
      // 로비가 닫힌 뒤(오픈 지남)의 로비 요청: 계약의 409에 type이 없어 about:blank로 답한다
      const lobbyClosed = () => send(409, { type: 'about:blank', title: '로비가 닫혔습니다', status: 409 }, 'application/problem+json');

      if (kind === 'pre-verifications' && req.method === 'POST') {
        void io.readJson(req).then((b) => {
          const keys = b && typeof b === 'object' ? Object.keys(b) : [];
          // humanCheckToken은 계약에서 선택이다(없으면 위험 판정이 높게 본다)
          if (!b || typeof b !== 'object' || (b.humanCheckToken !== undefined && typeof b.humanCheckToken !== 'string') || keys.some((k) => !['humanCheckToken', 'deviceId', 'preverifyToken', 'behaviorSummary'].includes(k))) return io.badRequest();
          const s = b.behaviorSummary;
          if (s !== undefined && (typeof s !== 'object' || s === null || s.v !== 1 || !Number.isInteger(s.windowMs) || s.windowMs < 0 || s.windowMs > 3_600_000)) return io.badRequest();
          const mode = state.queuePreverify;
          if (mode === 'unauthorized') return send(401, { type: 'about:blank', title: 'Unauthorized', status: 401 }, 'application/problem+json');
          if (mode === 'identity') return problem(403, 'identity-verification-required', '휴대폰 본인확인을 먼저 해 주세요');
          if (mode === 'not-found' || !sched) return problem(404, 'queue-not-found', '대기열이 열리지 않았습니다');
          // 장애는 회차마다 한 번만(화면은 다시 보낼 때 새 사람 확인 토큰을 받으므로 토큰마다가 아니다)
          if (mode === 'down' && !e.once.has('pv:down')) {
            e.once.add('pv:down');
            // 게이트웨이 차단기·대기열 저장소 장애 꼴(guidelines §2)
            return problem(503, 'dependency-unavailable', '잠시 뒤 다시 시도해 주세요', { 'retry-after': '3' });
          }
          // 갱신이면 최초 발급 시각을 잇는다(토큰 원문에 담은 것처럼 흉내 낸다)
          const prev = typeof b.preverifyToken === 'string' ? /^pv\.(\d+)\./.exec(b.preverifyToken) : null;
          const first = prev ? Number(prev[1]) : now();
          return send(201, { preverifyToken: `pv.${first}.${randomUUID()}`, expiresAt: new Date(now() + 15 * 60_000).toISOString(), serverTimeMs: now() });
        });
        return true;
      }

      if (kind === 'lobby-participants' && req.method === 'POST') {
        void io.readJson(req).then((b) => {
          const keys = b && typeof b === 'object' ? Object.keys(b) : [];
          if (!b || typeof b.humanCheckToken !== 'string' || b.humanCheckToken.length === 0 || keys.some((k) => !['humanCheckToken', 'deviceId'].includes(k))) return io.badRequest();
          if (!sched || sched.lobbyOpensAtMs === null || now() < sched.lobbyOpensAtMs) return problem(409, 'queue-not-open', '아직 로비가 열리지 않았습니다');
          if (now() >= sched.openAtMs) return lobbyClosed();
          const mode = state.queueLobby;
          if (mode === 'unauthorized') return send(401, { type: 'about:blank', title: 'Unauthorized', status: 401 }, 'application/problem+json');
          if (mode === 'identity') return problem(403, 'identity-verification-required', '휴대폰 본인확인을 먼저 해 주세요');
          if (mode === 'human-fail') return problem(428, 'human-check-required', '사람 확인을 마친 뒤 다시 시도해 주세요');
          // 혼잡·장애는 사람 확인 토큰마다 한 번만(다시 보내면 지나간다)
          if ((mode === 'busy' || mode === 'down') && !e.once.has(`lobby:${b.humanCheckToken}`)) {
            e.once.add(`lobby:${b.humanCheckToken}`);
            return mode === 'busy'
              ? problem(429, 'server-busy', '요청이 많아 잠시 기다려야 합니다', { 'retry-after': '2' })
              : problem(503, 'dependency-unavailable', '잠시 후 다시 시도해 주세요', { 'retry-after': '1' });
          }
          // 다른 기기가 먼저 참가했다(로비 참가 취소 뒤에는 지나간다). 이 기기·다른 탭이 이미 받은 참가 토큰도 409다(pid당 1장)
          if ((mode === 'other-device' && !e.otherCleared) || e.lobby) return problem(409, 'already-waiting', '이미 다른 곳에서 로비에 들어와 있습니다');
          advance(e);
          const token = `lt.${randomUUID()}`;
          e.lobby = token;
          e.tickets.set(token, { seq: e.nextSeq++, admitted: false, soonShown: false });
          return send(201, {
            lobbyToken: token,
            seedHash: sha(`PEAKET-shuffle-v1${eventId}mock-seed`),
            drandChain: 'quicknet',
            drandRound: 1234567,
            algorithmVersion: 'v1',
            lobbyOpenedAt: new Date(sched.lobbyOpensAtMs).toISOString(),
            shuffleResultAt: new Date(sched.openAtMs + 3000).toISOString(),
            shuffleSpreadSec: 2,
            ...(mode === 'verify' ? { verification: 'REQUIRED', verificationReason: 'NETWORK' } : { verificationReason: null }),
            serverTimeMs: now(),
          });
        });
        return true;
      }

      if (kind === 'lobby-participants/me' && req.method === 'DELETE') {
        if (sched && now() >= sched.openAtMs) return lobbyClosed(), true;
        // 팬 쿠키로 부르므로 다른 기기의 참가 토큰도 취소한다(ADR-0060)
        if (state.queueLobby === 'other-device' && !e.otherCleared && !e.lobby) {
          e.otherCleared = true;
          return send(204, undefined), true;
        }
        if (!e.lobby) return problem(404, 'not-found', '참가 토큰이 없습니다'), true;
        e.tickets.delete(e.lobby);
        e.removed.add(e.lobby);
        e.lobby = null;
        send(204, undefined);
        return true;
      }

      if (kind === 'shuffle-proof' && req.method === 'GET') {
        if (!sched) return problem(404, 'queue-not-found', '이 회차의 셔플 정보가 없습니다'), true;
        const t = now();
        const opensAt = sched.openAtMs;
        // 검증 화면용 공시 기록(ADR-0232). 커밋·비콘은 규격대로 맞는다. queueProof=normal은 결과 파일이 합성이라 머클 루트 대조가 일치로 나오지 않고, 그 밖의 값은 결과 파일까지 맞춘다(lobbyWorld)
        const group = (name, path) => ({
          chain: 'quicknet',
          algorithm: 'v1',
          fixedAt: new Date(name === 'lobby' ? opensAt : opensAt + 2000).toISOString(),
          resultPathPrefix: `/v1/queues/${eventId}/${path}/`,
          fileCount: 4096,
          commit: hashBytes('PEAKET-shuffle-v1', eventId, bytes(seedOf(name))),
          committedAt: new Date(opensAt - 600_000).toISOString(),
          round: 8_000_000,
          roundAt: new Date(opensAt + 3000).toISOString(),
          ...(t >= opensAt ? { merkleRoot: sha(`root-${name}-${eventId}`), rootAt: new Date(opensAt + 1000).toISOString(), firstSeq: 1, participantCount: 1 } : {}),
          ...(t >= opensAt + 3000 ? { beacon: beaconOf(name), beaconSignature: sigOf(name), publishedAt: new Date(opensAt + 3000).toISOString() } : {}),
          ...(t >= opensAt + 3_600_000 ? { seed: seedOf(name), seedRevealedAt: new Date(opensAt + 3_600_000).toISOString() } : {}),
        });
        // 비상 표시가 있는 구간에는 비콘 기록이 없다(ADR-0239 결정 11). 읽지 못한 비상 칸도 같다
        const withoutBeacon = ({ beacon: _b, beaconSignature: _s, ...rest }) => rest;
        const disclosed = (g) => {
          const mode = state.queueProof;
          if (mode === 'emergency') return { ...withoutBeacon(g), emergency: { at: new Date(opensAt + 70_000).toISOString(), reason: '비콘을 60초 넘게 받지 못해 RB-35 비상 셔플을 실행했습니다', stopReason: 'beacon', limitation: '이 경우 시드를 아는 내부자가 결과를 미리 알 수 있다' } };
          if (mode === 'disguised') return { ...g, beacon: EMERGENCY_BEACON_HEX, beaconSignature: Buffer.from('PEAKET-shuffle-v1-no-beacon', 'utf8').toString('hex') };
          if (mode === 'invalid-emergency') return { ...withoutBeacon(g), invalidDisclosures: ['emergency'] };
          if (mode === 'invalid-redisclosures') return { ...g, invalidDisclosures: ['redisclosures'] };
          if (mode === 'redisclosed') return { ...g, redisclosures: [{ at: new Date(opensAt - 300_000).toISOString(), previousRound: g.round - 20, round: g.round, reason: '오픈 시각이 바뀌어 라운드를 다시 공시했습니다' }] };
          return g;
        };
        const answer = (lobby) => send(200, { eventId, opensAt: new Date(opensAt).toISOString(), seedRevealAt: new Date(opensAt + 3_600_000).toISOString(), lobby: disclosed(lobby), batch: group('batch', 'batch-results') }, undefined, { 'cache-control': 'public, max-age=5' });
        const lobby = group('lobby', 'shuffle-results');
        if (state.queueProof === 'normal' || lobby.merkleRoot === undefined) {
          answer(lobby);
          return true;
        }
        void lobbyWorld(eventId).then((w) => answer({ ...lobby, merkleRoot: w.rootHex, participantCount: PROOF_TOKENS.length }));
        return true;
      }

      if (shufflePrefix && req.method === 'GET') {
        const publishAt = sched ? sched.openAtMs + (state.queueShuffle === 'late' ? 43_000 : 3000) : Infinity;
        if (state.queueShuffle === 'never' || now() < publishAt) return send(404, { type: 'about:blank', title: 'Not Found', status: 404 }, 'application/problem+json', { 'cache-control': 'public, max-age=1' }), true;
        if (state.queueProof !== 'normal') {
          // 공시 상태를 보는 값: ⑥이 끝까지 가도록 규격대로 맞춘 파일을 낸다(내 참가 토큰은 들지 않는다, PROOF_TOKENS)
          void lobbyWorld(eventId).then(({ entries }) => send(200, Object.fromEntries(Object.entries(entries).filter(([h]) => h.startsWith(shufflePrefix))), undefined, { 'cache-control': 'public, max-age=60' }));
          return true;
        }
        // 목록을 고정한 뒤의 파일: 아직 취소되지 않은 참가 토큰만 든다(missing이면 다른 기기에서 취소된 것처럼 내 토큰을 뺀다)
        const table = { [sha(`decoy-${shufflePrefix}`)]: 1 };
        if (e.lobby && state.queueShuffle !== 'missing' && sha(e.lobby).startsWith(shufflePrefix)) table[sha(e.lobby)] = e.tickets.get(e.lobby).seq;
        send(200, table, undefined, { 'cache-control': 'public, max-age=60' });
        return true;
      }

      if (kind === 'entries' && req.method === 'POST') {
        void io.readJson(req).then((b) => {
          const keys = b && typeof b === 'object' ? Object.keys(b) : [];
          if (!b || typeof b.preverifyToken !== 'string' || b.preverifyToken.length === 0 || keys.some((k) => !['preverifyToken', 'deviceId', 'entryRequestId'].includes(k)) || (b.entryRequestId !== undefined && !UUID.test(b.entryRequestId))) return io.badRequest();
          const id = b.entryRequestId ?? randomUUID();
          const mode = state.queueEntry;
          // 멈춤: 답하지 않는다(화면의 5초 시간 초과·화면 떠남을 보려고, FE-T15, ADR-0217). 손님이 끊으면 검사 기록에 남는다
          if (mode === 'hang') return;
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
        for (const t of e.tickets.keys()) e.removed.add(t);
        e.tickets.clear();
        e.entries.clear();
        e.lobby = null;
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
            soldOutTiers: state.queueSoldOutTiers ? state.queueSoldOutTiers.split(',').filter(Boolean) : [],
            removedUpToServing: 0,
            removedBeforeSegment: 0,
            removedBitmap: bitmap.toString('base64'),
            ...(state.queueBanner ? { banner: state.queueBanner } : {}),
            generatedAtMs: Math.floor(now() / 1000) * 1000,
            pollHintMs: 0,
            ...(seats === undefined ? {} : { remainingSeats: seats, avgTicketsPerOrder: 2 }),
            seatmapLayoutPath: `/v1/events/${eventId}/seatmap-layouts/2.json`,
          },
          undefined,
          { 'cache-control': 'public, max-age=1, stale-while-revalidate=2', ...(state.queueStateRetryAfter ? { 'retry-after': state.queueStateRetryAfter } : {}) },
        );
        return true;
      }

      if (kind === 'admission' && req.method === 'POST') {
        void io.readJson(req).then((b) => {
          const keys = b && typeof b === 'object' ? Object.keys(b) : [];
          const key = typeof b?.queueTicket === 'string' ? b.queueTicket : typeof b?.lobbyToken === 'string' ? b.lobbyToken : null;
          if (!b || key === null || (b.queueTicket !== undefined && b.lobbyToken !== undefined) || keys.some((k) => !['queueTicket', 'lobbyToken', 'priorityGrantId', 'firstEtaSec', 'firstEtaAtMs'].includes(k))) return io.badRequest();
          // 취소된 참가 토큰·대기표(다른 기기에서 취소)
          if (e.removed.has(key)) return problem(410, 'queue-ticket-removed', '대기가 취소됐습니다');
          const t = e.tickets.get(key);
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
            admissionToken: mockAdmissionToken(randomUUID(), eventId, now()),
            purchaseSessionExpiresAt: new Date(now() + 45 * 60_000).toISOString(),
            serverEcdhPublicKey: { kty: 'EC', crv: 'P-256', x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU', y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0', kid: 'mock-ecdh-1' },
            seatmapLayoutPath: `/v1/events/${eventId}/seatmap-layouts/2.json`,
            serverTimeMs: now(),
          });
        });
        return true;
      }
      return false;
    },
  };
}
