// 관제 늘 여는 SSE 흐름 단위 시험(F-03-1 OPS-340, BAT-465 R-584를 바뀐 정본에 맞춰 다시 씀).
// 정본: ADR-0100 결정 2(형식 retry: 10000·15초 ': hb'·Last-Event-ID·1시간 reset)·결정 4(알림 표 순번), ADR-0360 결정 2(빈 번호 2초)·4(받는 사람)·5(토큰 만료·세션 종료·1MiB),
// docs/frontend.md §4.4.4(닫힘: 머리 없으면 연 뒤 15분, 세션 종료 5초마다). 단언 값은 정본에서 가져오고 코드 상수를 옮기지 않는다.
// 실제 PostgreSQL·HTTP 위 같은 판정은 test-int/ops-live.int.test.ts가 본다.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Principal } from '@peaket/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AuditCheckpointService, MemoryAuditChain, MemoryAuditCheckpointStore } from '../src/modules/audit/index.js';
import { CreateCommand, MemoryCommandStore } from '../src/modules/commands/index.js';
import { OpsLiveFeed, SseConnection, formatSse, lastEventIdOf, resumeVerdictOf, settleRows, sseOpening, tokenDeadlineOf, type PushEventRow } from '../src/modules/live/index.js';

/** 정본 값(코드 상수를 가져오지 않는다) */
const CANON = {
  retryMs: 10_000, // ADR-0100 결정 2 retry: 10000
  heartbeatMs: 15_000, // ADR-0100 결정 2 15초 [가정]
  tokenTtlMs: 15 * 60_000, // frontend §4.4.4 '없으면 연 뒤 15분'
  sessionCheckMs: 5_000, // frontend §4.4.4 '5초 [가정]마다 본다'
  pendingLimitBytes: 1024 * 1024, // frontend §4.4.4 '1MiB [가정]'
  gapWaitMs: 2_000, // ADR-0360 결정 2 '2초 [가정] 뒤에도 비면 건너뛴다'
};

const OPEN_MS = Date.parse('2026-11-23T01:00:00.000Z');

/** SseConnection이 쓰는 응답 소켓 면(writeHead·write·writableLength·end·destroy)만 가진 가짜 */
class FakeSocket {
  readonly chunks: string[] = [];
  pending = 0;
  ended = false;
  destroyed = false;
  head: { status: number; headers: Record<string, string> } | undefined;
  writeHead(status: number, headers: Record<string, string>): this {
    this.head = { status, headers };
    return this;
  }
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  get writableLength(): number {
    return this.pending;
  }
  end(): void {
    this.ended = true;
  }
  destroy(): void {
    this.destroyed = true;
  }
  text(): string {
    return this.chunks.join('');
  }
}

const principal = (role: string, accountId: string = randomUUID()): Principal => ({ accountId, sessionId: randomUUID(), aud: 'ops', scopes: [], role });

function connection(o: { headers?: Record<string, string>; me?: Principal; terminated?: Set<string> } = {}) {
  const socket = new FakeSocket();
  const requestRaw = new EventEmitter();
  // type-escape: SseConnection은 FastifyRequest의 headers·raw.on, FastifyReply의 hijack·raw만 쓴다. 진짜 Fastify 응답 위 흐름은 test-int/ops-live.int.test.ts(F-03-1 T1·T4)가 본다 F-03-1
  const request = { headers: o.headers ?? {}, raw: requestRaw } as unknown as FastifyRequest;
  // type-escape: 위와 같다 F-03-1
  const reply = { hijack: () => undefined, raw: socket } as unknown as FastifyReply;
  const conn = new SseConnection(request, reply, {
    stream: 'ops-live',
    me: o.me ?? principal('operator'),
    nowMs: OPEN_MS,
    ...(o.terminated ? { terminated: { has: (id: string) => o.terminated!.has(id) } } : {}),
  });
  return { conn, socket, requestRaw };
}

/** SSE 글을 표준 규칙대로 줄로 나눈다(주석 줄·빈 줄 뺀 필드 목록) */
const fieldsOf = (text: string) =>
  text
    .split(/\r\n|\r|\n/)
    .filter((l) => l !== '' && !l.startsWith(':'))
    .map((l) => {
      const i = l.indexOf(':');
      return { field: i < 0 ? l : l.slice(0, i), value: i < 0 ? '' : l.slice(i + 1).replace(/^ /, '') };
    });

describe('F-03-1 관제 늘 여는 흐름 형식과 닫힘(서버 단위)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('F-03-1 T3 FE-T28 ③-1 첫 덩이는 retry: 10000이고 커서가 있으면 사건 없이 id 줄만 둔다', () => {
    expect(sseOpening()).toBe(`retry: ${CANON.retryMs}\n\n`);
    expect(sseOpening(48213)).toBe(`retry: ${CANON.retryMs}\nid: 48213\n\n`);
    const { conn, socket } = connection();
    conn.open(7);
    expect(socket.head).toEqual({ status: 200, headers: expect.objectContaining({ 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' }) });
    expect(socket.chunks[0]).toBe(`retry: ${CANON.retryMs}\nid: 7\n\n`);
    conn.close('client');
  });

  test('F-03-1 T3 FE-T28 ③-2 서버는 15초마다 주석 줄 ": hb"를 보내고 14,999ms에는 아직 보내지 않는다', () => {
    const { conn, socket } = connection();
    conn.open();
    const hbCount = () => socket.chunks.filter((c) => c === ': hb\n\n').length;
    vi.advanceTimersByTime(CANON.heartbeatMs - 1);
    expect(hbCount()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(hbCount()).toBe(1);
    vi.advanceTimersByTime(CANON.heartbeatMs);
    expect(hbCount()).toBe(2);
    // 옛 모양(': ping')은 남지 않는다
    expect(socket.text()).not.toContain(': ping');
    conn.close('client');
  });

  test('F-03-1 T13 [ASVS v5.0.0-1.2.3] 본문 글에 줄바꿈·event:·id:가 들어도 data: 한 줄이라 새 사건·새 id가 생기지 않는다', () => {
    const evil = 'a\n\nevent: reset\ndata: {"reason":"too-old"}\r\nid: 99\rretry: 1';
    const text = formatSse({ id: 7, event: 'command', data: { reason: evil } });
    const fields = fieldsOf(text);
    expect(fields.map((f) => f.field)).toEqual(['id', 'event', 'data']);
    expect(fields[0]!.value).toBe('7');
    expect(fields[1]!.value).toBe('command');
    expect(JSON.parse(fields[2]!.value)).toEqual({ reason: evil });
    // 사건 하나 = 빈 줄로 끝나는 덩이 하나
    expect(text.endsWith('\n\n')).toBe(true);
    expect(text.slice(0, -2)).not.toMatch(/\n\n|\r/);
  });

  test('F-03-1 T4 FE-T28 ④-1 닫을 시각은 X-User-Token-Exp와 연 뒤 15분 가운데 이른 쪽이다(7분 토큰·20분 토큰·머리 없음·꼴 틀림)', () => {
    const sevenMin = OPEN_MS + 7 * 60_000;
    expect(tokenDeadlineOf(String(sevenMin / 1000), OPEN_MS)).toBe(sevenMin);
    // 머리로 늘릴 수 없다: 20분 토큰도 15분에 닫는다
    expect(tokenDeadlineOf(String((OPEN_MS + 20 * 60_000) / 1000), OPEN_MS)).toBe(OPEN_MS + CANON.tokenTtlMs);
    expect(tokenDeadlineOf(undefined, OPEN_MS)).toBe(OPEN_MS + CANON.tokenTtlMs);
    expect(tokenDeadlineOf('soon', OPEN_MS)).toBe(OPEN_MS + CANON.tokenTtlMs);
    expect(tokenDeadlineOf('-5', OPEN_MS)).toBe(OPEN_MS + CANON.tokenTtlMs);
  });

  test('F-03-1 T4 FE-T28 ④-2 7분 토큰 흐름은 7분 - 1ms에는 열려 있고 7분에 token-expired로 닫힌다', () => {
    const exp = OPEN_MS + 7 * 60_000;
    const { conn, socket } = connection({ headers: { 'x-user-token-exp': String(exp / 1000) } });
    conn.open();
    vi.advanceTimersByTime(exp - OPEN_MS - 1);
    expect(conn.closed).toBe(false);
    expect(socket.ended).toBe(false);
    vi.advanceTimersByTime(1);
    expect(conn.closedReason).toBe('token-expired');
    expect(socket.ended).toBe(true);
    // 닫힌 뒤에는 쓰지 않는다
    const n = socket.chunks.length;
    conn.send({ id: 1, event: 'command', data: {} });
    vi.advanceTimersByTime(CANON.heartbeatMs);
    expect(socket.chunks.length).toBe(n);
  });

  test('F-03-1 T4 FE-T28 ④-3 머리가 없으면 연 뒤 15분에 닫는다(14분 59.999초에는 열려 있다)', () => {
    const { conn } = connection();
    conn.open();
    vi.advanceTimersByTime(CANON.tokenTtlMs - 1);
    expect(conn.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(conn.closedReason).toBe('token-expired');
  });

  test('F-03-1 T4 FE-T28 ④-4 세션이 끝나면 5초마다 보는 종료 세션 목록으로 session-ended로 닫고, 다른 세션은 그대로다', () => {
    const terminated = new Set<string>();
    const me = principal('operator');
    const other = connection({ me: principal('operator'), terminated });
    const mine = connection({ me, terminated });
    mine.conn.open();
    other.conn.open();
    terminated.add(me.sessionId);
    vi.advanceTimersByTime(CANON.sessionCheckMs - 1);
    expect(mine.conn.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(mine.conn.closedReason).toBe('session-ended');
    expect(mine.socket.ended).toBe(true);
    expect(other.conn.closed).toBe(false);
    other.conn.close('client');
  });

  test('F-03-1 T4 FE-T28 ④-5 브라우저가 끊으면 client로 닫고 닫을 때 구독 끊기를 부른다', () => {
    const { conn, requestRaw } = connection();
    const unsubscribed = vi.fn<() => void>();
    conn.onClose(unsubscribed);
    conn.open();
    requestRaw.emit('close');
    expect(conn.closedReason).toBe('client');
    expect(unsubscribed).toHaveBeenCalledTimes(1);
  });

  test('F-03-1 T16 쌓인 양이 1MiB이면 그대로이고 1MiB를 넘으면 backpressure로 끊는다(소켓을 부순다)', () => {
    const { conn, socket } = connection();
    conn.open();
    socket.pending = CANON.pendingLimitBytes;
    conn.send({ id: 1, event: 'command', data: { commandId: 'c1' } });
    expect(conn.closed).toBe(false);
    socket.pending = CANON.pendingLimitBytes + 1;
    conn.send({ id: 2, event: 'command', data: { commandId: 'c2' } });
    expect(conn.closedReason).toBe('backpressure');
    expect(socket.destroyed).toBe(true);
    expect(socket.ended).toBe(false);
    const n = socket.chunks.length;
    conn.send({ id: 3, event: 'command', data: { commandId: 'c3' } });
    expect(socket.chunks.length).toBe(n);
  });
});

describe('F-03-1 다시 붙기 판정과 빈 번호(서버 단위)', () => {
  test('F-03-1 T2 FE-T28 ②-1 Last-Event-ID는 순번이면 그 뒤, 비면 지금부터, 숫자가 아니면 reset(invalid)이다', () => {
    expect(lastEventIdOf(undefined)).toEqual({ kind: 'none' });
    expect(lastEventIdOf('')).toEqual({ kind: 'none' });
    expect(lastEventIdOf('48213')).toEqual({ kind: 'since', seq: 48213 });
    for (const bad of ['abc', '-1', '1.5', '1e3', '0x10', '12345678901234567']) expect(lastEventIdOf(bad), bad).toEqual({ kind: 'reset', reason: 'invalid' });
  });

  test('F-03-1 T2 FE-T28 ②-2 창 안 가장 오래된 행 바로 앞까지는 다시 보내고 그보다 앞이면 too-old, 만든 적 없는 번호면 invalid다', () => {
    // 표: 창(1시간) 안 행은 seq 40~50
    expect(resumeVerdictOf(50, 50, 40)).toBe('ok');
    expect(resumeVerdictOf(39, 50, 40)).toBe('ok');
    expect(resumeVerdictOf(38, 50, 40)).toBe('too-old');
    expect(resumeVerdictOf(51, 50, 40)).toBe('invalid');
    // 창 안 행이 없는데 놓친 번호가 있으면 too-old
    expect(resumeVerdictOf(10, 50, undefined)).toBe('too-old');
  });

  test('F-03-1 T1 FE-T28 ①-1 빈 번호에서 멈추고 2초가 지나야 건너뛴다(1,999ms에는 기다린다)', () => {
    const row = (seq: number): PushEventRow => ({ seq, kind: 'command', eventId: null, roles: ['operator'], body: { commandId: `c${seq}` }, createdAtMs: OPEN_MS });
    const rows = [row(1), row(2), row(4), row(5)];
    const first = settleRows(rows, 0, undefined, OPEN_MS, CANON.gapWaitMs);
    expect(first.ready.map((r) => r.seq)).toEqual([1, 2]);
    expect(first.cursor).toBe(2);
    expect(first.gapSince).toBe(OPEN_MS);
    const waiting = settleRows(rows, first.cursor, first.gapSince, OPEN_MS + CANON.gapWaitMs - 1, CANON.gapWaitMs);
    expect(waiting.ready).toEqual([]);
    expect(waiting.cursor).toBe(2);
    // 기다리는 동안 3이 커밋되면 차례대로 낸다
    const filled = settleRows([row(3), ...rows.slice(2)], first.cursor, first.gapSince, OPEN_MS + 1_000, CANON.gapWaitMs);
    expect(filled.ready.map((r) => r.seq)).toEqual([3, 4, 5]);
    const skipped = settleRows(rows, first.cursor, first.gapSince, OPEN_MS + CANON.gapWaitMs, CANON.gapWaitMs);
    expect(skipped.ready.map((r) => r.seq)).toEqual([4, 5]);
    expect(skipped.cursor).toBe(5);
    expect(skipped.gapSince).toBeUndefined();
  });
});

describe('F-03-1 받는 사람(서버 단위)', () => {
  const world = () => {
    const chain = new MemoryAuditChain();
    const checkpoints = new AuditCheckpointService(new MemoryAuditCheckpointStore(), chain, () => OPEN_MS);
    const store = new MemoryCommandStore(chain);
    return { create: new CreateCommand(store), feed: new OpsLiveFeed({ commands: store, checkpoints }) };
  };

  test('F-03-1 T8 (권한) 승인 대기 사건은 요청자 본인·viewer·CS에게 가지 않고 승인할 수 있는 다른 operator·commander에게만 간다', async () => {
    const w = world();
    const requester = principal('operator');
    // 명령 4는 ASN이 있으면 2인이다(ADR-0339 결정 1). 승인 역할은 operator·commander
    const command = await w.create.execute({
      type: 'BLOCK_ASN_IP',
      reason: '대역 차단',
      params: { asns: [64512], expiresAt: new Date(OPEN_MS + 60 * 60_000).toISOString() },
      requestedBy: requester.accountId,
      requestedRole: 'operator',
      nowMs: OPEN_MS,
    });
    expect(command.state).toBe('PENDING_APPROVAL');
    const body = { commandId: command.commandId, type: 'BLOCK_ASN_IP', state: 'PENDING_APPROVAL', approvalExpiresAt: '2026-11-23T01:30:00.000Z' };
    const row: PushEventRow = { seq: 12, kind: 'approval', eventId: null, roles: ['operator', 'commander'], body, createdAtMs: OPEN_MS };
    const [d] = await w.feed.resolve([row]);
    const expected = { id: 12, event: 'approval', data: body };
    expect(w.feed.eventFor(d!, principal('operator'))).toEqual(expected);
    expect(w.feed.eventFor(d!, principal('commander'))).toEqual(expected);
    // 요청자 본인(같은 계정이면 역할이 commander여도)
    expect(w.feed.eventFor(d!, requester)).toBeUndefined();
    expect(w.feed.eventFor(d!, principal('commander', requester.accountId))).toBeUndefined();
    for (const role of ['viewer', 'cs_agent', 'cs_lead']) expect(w.feed.eventFor(d!, principal(role)), role).toBeUndefined();
    expect(w.feed.eventFor(d!, undefined)).toBeUndefined();
    // 같은 명령의 command 사건은 viewer도 받는다(명령 목록 REST와 같다), CS는 받지 않는다
    const cmd: PushEventRow = { seq: 11, kind: 'command', eventId: null, roles: ['viewer', 'operator', 'commander'], body: { commandId: command.commandId, state: 'PENDING_APPROVAL' }, createdAtMs: OPEN_MS };
    const [c] = await w.feed.resolve([cmd]);
    expect(w.feed.eventFor(c!, principal('viewer'))).toMatchObject({ id: 11, event: 'command', data: { commandId: command.commandId, state: 'PENDING_APPROVAL', canApprove: false } });
    expect(w.feed.eventFor(c!, principal('cs_agent'))).toBeUndefined();
  });
});
