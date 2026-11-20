// 가짜 API의 좌석 델타 WebSocket 대역(docs/frontend.md §4.4.1, BUILD_ORDER HOT-357·BAT-182). 로컬 개발·브라우저 확인 전용이다.
// 실제 realtime-gw 대신 같은 주소(`/v1/events/{id}/seats/stream`)·같은 하위 프로토콜(`peaket.seats.v1`+`peaket.auth.{토큰}`)·같은 바이트를 쓴다.
// 프레임 해독은 `@peaket/seatmap`의 wire.ts를 그대로 가져와 서버·화면 바이트가 어긋나지 않게 한다(계획 §12-6).
// - 첫 프레임 `BatchInterval`(100), `TimeSync`→`Heartbeat`(echo), `SubscribeSections` 17개 이상은 4429로 닫는다.
// - 상태 바꾸기(브라우저·개발 확인): GET /__mock/seat-state?op=delta&section=0&seat=3&state=1
//   op=close&code=4401(닫힘 코드), op=interval&ms=1000(Degraded), op=reset(기록 지움)
// - 기록 보기: GET /__mock/seat-stream(연결·구독·최대 구독 수·닫힘·TimeSync 시각)
import { createHash } from 'node:crypto';
import { encodeBatchInterval, encodeDeltaBatch, encodeHeartbeat, MAX_SUBSCRIBED_SECTIONS } from '../../../../packages/seatmap/src/wire.ts';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PATH = /^\/v1\/events\/([^/]+)\/seats\/stream$/;
const EVENT_ID = /^[A-Za-z0-9-]{1,64}$/;
const SEATS_PROTOCOL = 'peaket.seats.v1';
const AUTH_PREFIX = 'peaket.auth.';
const OPCODE = { text: 1, binary: 2, close: 8, ping: 9, pong: 10 };
const TYPE = { delta: 1, heartbeat: 2, batchInterval: 3, subscribe: 16, timeSync: 18 };
/** 닫힘 이유 글(계약, §4.4.1). 받은 값을 그대로 싣지 않는다 */
const REASON = { tooMany: 'too many', badFrame: 'bad frame' };

/** 서버 → 클라이언트 프레임 하나(마스크 없음) */
function encodeFrame(opcode, payload) {
  const body = Buffer.from(payload);
  const len = body.byteLength;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65_536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, body]);
}

/** 닫힘 프레임(코드 + 이유 글) */
function closeFrame(code, reason) {
  const text = Buffer.from(reason ?? '', 'utf8');
  const payload = Buffer.alloc(2 + text.byteLength);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return encodeFrame(OPCODE.close, payload);
}

/** 클라이언트 프레임 해석기(마스크를 풀고, 조각난 프레임은 받지 않는다: 화면은 늘 한 프레임에 보낸다) */
function frameParser(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const opcode = b0 & 0x0f;
      const fin = (b0 & 0x80) !== 0;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      off += maskLen;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + len);
      if (!fin) return onFrame({ opcode: -1, payload: Buffer.alloc(0) });
      onFrame({ opcode, payload });
      if (opcode === OPCODE.close) return;
    }
  };
}

/**
 * 좌석 스트림 대역 하나. `handleUpgrade(req, socket)`와 `control(searchParams)`, `log()`를 낸다.
 * @param {{ now?: () => number }} [o]
 */
export function createSeatStreamMock(o = {}) {
  const now = o.now ?? Date.now;
  const connections = new Set();
  /** 구역 일련번호(스냅샷의 1에서 시작, delta 제어가 하나씩 올린다) */
  const versions = new Map();
  let nextId = 1;
  const record = { opened: 0, closed: [], subscribed: [], maxSubscribed: 0, timeSyncs: [], batches: 0, rejected: [], intervals: [] };

  const versionOf = (section) => versions.get(section) ?? 1;
  const sendRaw = (conn, frame) => {
    if (conn.socket.writable) conn.socket.write(frame);
  };
  const send = (conn, payload) => sendRaw(conn, encodeFrame(OPCODE.binary, payload));
  const close = (conn, code, reason) => {
    record.closed.push({ code, reason: reason ?? null, at: now() });
    sendRaw(conn, closeFrame(code, reason));
    conn.socket.end();
    connections.delete(conn);
  };
  const reject = (socket, status) => {
    record.rejected.push({ status, at: now() });
    socket.end(`HTTP/1.1 ${status} ${status === 404 ? 'Not Found' : status === 401 ? 'Unauthorized' : 'Bad Request'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  function handleUpgrade(req, socket) {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const m = PATH.exec(u.pathname);
    if (!m || !EVENT_ID.test(m[1]) || req.method !== 'GET') return reject(socket, 404);
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
    if (upgrade !== 'websocket' || typeof key !== 'string' || Buffer.from(key, 'base64').byteLength !== 16 || req.headers['sec-websocket-version'] !== '13') return reject(socket, 400);
    // 출처는 로컬 개발 주소만 받는다(운영 realtime-gw의 Origin 확인과 같은 자리, §4.4.1)
    const origin = req.headers.origin;
    if (origin) {
      try {
        const h = new URL(origin).hostname;
        if (h !== '127.0.0.1' && h !== 'localhost' && h !== '[::1]') return reject(socket, 401);
      } catch {
        return reject(socket, 401);
      }
    }
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!protocols.includes(SEATS_PROTOCOL) || protocols.filter((p) => p.startsWith(AUTH_PREFIX)).length !== 1) return reject(socket, 401);

    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${SEATS_PROTOCOL}\r\n\r\n`);
    const conn = { id: nextId++, socket, subscribed: new Set(), versions: new Map() };
    connections.add(conn);
    record.opened++;
    socket.on('error', () => connections.delete(conn));
    socket.on('close', () => connections.delete(conn));
    socket.on('data', frameParser(({ opcode, payload }) => {
      if (opcode === OPCODE.close) {
        sendRaw(conn, closeFrame(1000, ''));
        conn.socket.end();
        connections.delete(conn);
        return;
      }
      if (opcode === OPCODE.ping) return sendRaw(conn, encodeFrame(OPCODE.pong, payload));
      if (opcode !== OPCODE.binary || payload.byteLength < 2 || payload[0] !== 1) return close(conn, 4403, REASON.badFrame);
      // 화면이 보내는 것은 SubscribeSections(16)·TimeSync(18)뿐이다(§4.4.1). 17(Auth)도 받지 않는다
      const type = payload[1];
      if (type === TYPE.timeSync) {
        if (payload.byteLength !== 10) return close(conn, 4403, REASON.badFrame);
        const clientTimeMs = Number(payload.readBigUInt64LE(2));
        record.timeSyncs.push({ at: now(), clientTimeMs });
        send(conn, encodeHeartbeat(now(), clientTimeMs));
        return;
      }
      if (type !== TYPE.subscribe) return close(conn, 4403, REASON.badFrame);
      const count = payload.readUInt16LE(2);
      if (payload.byteLength !== 4 + 2 * count) return close(conn, 4403, REASON.badFrame);
      if (count > MAX_SUBSCRIBED_SECTIONS) return close(conn, 4429, REASON.tooMany);
      const list = [];
      for (let i = 0; i < count; i++) list.push(payload.readUInt16LE(4 + i * 2));
      conn.subscribed = new Set(list);
      record.subscribed.push([...list]);
      record.maxSubscribed = Math.max(record.maxSubscribed, list.length);
    }));
    // 맺은 뒤 첫 프레임은 BatchInterval이다(§4.4.1)
    send(conn, encodeBatchInterval(100));
    record.intervals.push(100);
  }

  /** /__mock/seat-state의 상태 바꾸기 */
  function control(params) {
    const op = params.get('op') ?? 'delta';
    if (op === 'reset') {
      record.closed.length = 0;
      record.subscribed.length = 0;
      record.timeSyncs.length = 0;
      record.rejected.length = 0;
      record.intervals.length = 0;
      record.maxSubscribed = 0;
      record.opened = connections.size;
      return { ok: true, op };
    }
    if (op === 'delta') {
      const section = Number(params.get('section') ?? 0);
      const seat = Number(params.get('seat') ?? 0);
      const state = Number(params.get('state') ?? 1);
      if (!Number.isInteger(section) || section < 0 || section > 65_535 || !Number.isInteger(seat) || seat < 0 || ![0, 1, 2].includes(state)) return { ok: false, op, error: 'bad-section-seat-state' };
      // 연결마다 마지막으로 보낸 판 + 1을 싣는다(화면이 늘 '다음 번호'로 받아 갭 없이 반영한다)
      let sent = 0;
      let sectionVersion = 1;
      for (const conn of connections) {
        if (!conn.subscribed.has(section)) continue;
        sectionVersion = (conn.versions.get(section) ?? 1) + 1;
        conn.versions.set(section, sectionVersion);
        send(conn, encodeDeltaBatch({ serverTimeMs: now(), maxWaitMs: 0, seatEpoch: 1, sections: [{ sectionIndex: section, sectionVersion, offsets: [seat], states: [state] }] }));
        sent++;
      }
      versions.set(section, Math.max(versionOf(section), sectionVersion));
      record.batches += sent;
      return { ok: true, op, section, sectionVersion, sent };
    }
    if (op === 'close') {
      const code = Number(params.get('code') ?? 4401);
      if (!Number.isInteger(code) || code < 1000 || code > 4999) return { ok: false, op, error: 'bad-code' };
      const reason = code === 4429 ? REASON.tooMany : code === 4403 ? REASON.badFrame : 'mock close';
      const n = connections.size;
      for (const conn of [...connections]) close(conn, code, reason);
      return { ok: true, op, code, closed: n };
    }
    if (op === 'interval') {
      const ms = Number(params.get('ms') ?? 1000);
      if (!Number.isInteger(ms) || ms < 0 || ms > 65_535) return { ok: false, op, error: 'bad-ms' };
      const frame = encodeBatchInterval(ms);
      for (const conn of connections) send(conn, frame);
      record.intervals.push(ms);
      return { ok: true, op, ms, sent: connections.size };
    }
    return { ok: false, op, error: 'unknown-op' };
  }

  function log() {
    return {
      connections: connections.size,
      opened: record.opened,
      maxSubscribed: record.maxSubscribed,
      subscribed: record.subscribed,
      closed: record.closed,
      rejected: record.rejected,
      timeSyncs: record.timeSyncs,
      batches: record.batches,
      intervals: record.intervals,
    };
  }

  return { handleUpgrade, control, log };
}
