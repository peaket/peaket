// 관제 SSE(BAT-465 R-584) 단위 시험: 훑기, Last-Event-ID 판정, SSE 형식, 연결 첫 사건(reset).
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { AuditCheckpointService, MemoryAuditChain, MemoryAuditCheckpointStore } from '../src/modules/audit/index.js';
import { CreateCommand, MemoryCommandStore } from '../src/modules/commands/index.js';
import { OpsLiveFeed, OPS_LIVE_REPLAY_WINDOW_MS, SSE_HEARTBEAT, formatSse, lastEventIdOf, liveDataOf } from '../src/modules/live/index.js';
import { OpsLiveController } from '../src/modules/live/inbound/ops-live.controller.js';

const NOW = Date.parse('2026-11-14T09:00:00.000Z');
const clock = fakeClock({ now: NOW });

const world = () => {
  const chain = new MemoryAuditChain();
  const checkpoints = new AuditCheckpointService(new MemoryAuditCheckpointStore(), chain, () => NOW);
  const store = new MemoryCommandStore(chain);
  const create = new CreateCommand(store);
  const feed = new OpsLiveFeed({ commands: store, checkpoints });
  return { chain, checkpoints, store, create, feed };
};

describe('BAT-465 관제 SSE', () => {
  test('R584_Last_Event_ID가_없으면_처음부터_1시간_안이면_그_뒤를_오래되면_reset이다', () => {
    expect(lastEventIdOf(undefined, NOW)).toEqual({ kind: 'none' });
    expect(lastEventIdOf('', NOW)).toEqual({ kind: 'none' });
    expect(lastEventIdOf(String(NOW - 1000), NOW)).toEqual({ kind: 'since', sinceMs: NOW - 1000 });
    expect(lastEventIdOf(String(NOW - OPS_LIVE_REPLAY_WINDOW_MS - 1), NOW)).toEqual({ kind: 'reset', reason: 'too-old' });
    expect(lastEventIdOf('abc', NOW)).toEqual({ kind: 'reset', reason: 'invalid' });
  });

  test('R584_SSE_형식은_id_event_data_순서다', () => {
    expect(formatSse({ id: 7, event: 'command', data: { commandId: 'c1' } })).toBe('id: 7\nevent: command\ndata: {"commandId":"c1"}\n\n');
    expect(SSE_HEARTBEAT).toBe(': ping\n\n');
  });

  test('R584_훑기는_명령과_감사를_시각_차례로_돌려주고_이전_변경은_뺀다', async () => {
    const w = world();
    const eventId = randomUUID();
    const command = await w.create.execute({ type: 'SCALE_CHANGE', reason: '규모 올리기', params: { eventId, scale: 'LARGE' }, requestedBy: randomUUID(), requestedRole: 'operator', nowMs: NOW });
    await w.checkpoints.create({ reason: '점검', actorRef: randomUUID() });
    const all = await w.feed.scan(0);
    expect(all.map((e) => e.event).sort()).toEqual(['audit', 'command']);
    expect(all.every((e) => e.id === NOW)).toBe(true);
    expect(await w.feed.scan(NOW + 1)).toEqual([]);
    const one = await w.feed.scan(NOW);
    expect(one).toHaveLength(2);
    expect(liveDataOf(one.find((e) => e.event === 'command')!)).toMatchObject({ commandId: command.commandId, state: 'APPROVED' });
  });

  test('R584_오래된_Last_Event_ID면_연결_첫_사건이_reset이다', async () => {
    const w = world();
    const chunks: string[] = [];
    const raw = new Writable({
      write: (c, _e, cb) => {
        chunks.push(String(c));
        cb();
      },
    }) as Writable & { writeHead?: (s: number, h: Record<string, string>) => void };
    raw.writeHead = () => undefined;
    const request = Object.assign(new EventEmitter(), { headers: { 'last-event-id': String(NOW - OPS_LIVE_REPLAY_WINDOW_MS - 1) }, raw: new EventEmitter() });
    const reply = { raw, hijack: () => undefined };
    const controller = new OpsLiveController(w.feed, clock);
    await controller.stream(request as never, reply as never, { accountId: randomUUID(), sessionId: randomUUID(), aud: 'ops', scopes: [] } as never);
    await new Promise((r) => setTimeout(r, 30));
    request.raw.emit('close');
    expect(chunks.join('')).toContain('event: reset');
    expect(chunks.join('')).toContain('"reason":"too-old"');
  });
});
