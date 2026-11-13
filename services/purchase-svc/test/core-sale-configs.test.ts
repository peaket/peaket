// core-svc 내부 HTTP 경로에서 회차 판매 설정 사본을 읽는 어댑터(BAT-051, HOT-252).
// purchase-svc는 core DB에 직접 접속하지 않고, 404는 '사본 없음'(파일 설정 사용), 5xx·모양 오류는 닫힌 쪽(SaleConfigUnavailable)이다.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { CoreSaleConfigs, overlayOf, SaleConfigUnavailable } from '../src/modules/inventory/index.js';

const EVENT = '0190f3a1-7c2e-7a00-8000-000000000101';
const NOW = Date.parse('2026-11-04T03:00:00.000Z');

const body = (over: Record<string, unknown> = {}) => ({
  eventId: EVENT,
  productionId: '0190f3a1-7c2e-7a00-8000-000000000201',
  promoterId: '0190f3a1-7c2e-7a00-8000-000000000301',
  rev: 7,
  opensAtMs: NOW,
  startsAtMs: NOW + 86_400_000,
  lobbyMinutes: 10,
  lobbyShuffle: true,
  openBatch: true,
  perPersonLimit: 4,
  saleEndsAtMs: NOW + 3_600_000,
  layoutVersion: 3,
  salePolicy: [{ version: 1, name: '팬클럽', rounds: 'ALL', rule: { then: { limitPerPerson: 2 } } }],
  eligGates: [],
  eligLists: ['lumen-fanclub-2026'],
  ...over,
});

function harness(answers: (() => Response | Promise<Response>)[]) {
  const clock = fakeClock({ now: NOW });
  const calls: string[] = [];
  const client = {
    async request(r: { path: string; params?: Readonly<Record<string, string | number>> }) {
      calls.push(`${r.path}:${String(r.params?.eventId)}`);
      const next = answers.shift();
      if (!next) throw new Error('답이 준비되지 않았다');
      return next();
    },
  };
  return { clock, calls, adapter: new CoreSaleConfigs({ client, clock }) };
}

describe('CoreSaleConfigs: core-svc 판매 설정 사본 읽기', () => {
  test('BAT051_ 200이면 salePolicy·eligLists·한도·판매 종료·판을 읽고, TTL 안에서는 다시 부르지 않는다', async () => {
    const h = harness([() => new Response(JSON.stringify(body()), { status: 200 })]);
    expect(await h.adapter.get(EVENT)).toEqual({
      rev: 7,
      perPersonLimit: 4,
      saleEndsAtMs: NOW + 3_600_000,
      salePolicy: body().salePolicy,
      eligLists: ['lumen-fanclub-2026'],
      layoutVersion: 3,
    });
    expect(await h.adapter.get(EVENT)).toMatchObject({ rev: 7 });
    expect(h.calls).toHaveLength(1);
    h.clock.advance(5_001);
    // 다음 답이 없으므로 다시 부르면 던진다: TTL이 지나 새로 읽는다는 증거
    await expect(h.adapter.get(EVENT)).rejects.toBeInstanceOf(Error);
    expect(h.calls).toHaveLength(2);
  });

  test('BAT051_ 404는 사본 없음으로 1초 기억하고 undefined다(승인 전·로컬은 파일 설정을 쓴다)', async () => {
    const h = harness([() => new Response('{}', { status: 404 })]);
    expect(await h.adapter.get(EVENT)).toBeUndefined();
    expect(await h.adapter.get(EVENT)).toBeUndefined();
    expect(h.calls).toHaveLength(1);
  });

  test('BAT051_ 5xx·모양 오류는 SaleConfigUnavailable로 닫는다(정책을 건너뛰지 않는다)', async () => {
    const down = harness([() => new Response('{}', { status: 503 })]);
    await expect(down.adapter.get(EVENT)).rejects.toBeInstanceOf(SaleConfigUnavailable);
    const broken = harness([() => new Response(JSON.stringify(body({ perPersonLimit: 9 })), { status: 200 })]);
    await expect(broken.adapter.get(EVENT)).rejects.toBeInstanceOf(SaleConfigUnavailable);
    const badLists = harness([() => new Response(JSON.stringify(body({ eligLists: ['BAD'] })), { status: 200 })]);
    await expect(badLists.adapter.get(EVENT)).rejects.toBeInstanceOf(SaleConfigUnavailable);
  });

  test('BAT051_ overlayOf는 정의 밖 모양을 거부하고 layoutVersion 없는 사본도 받는다', () => {
    expect(overlayOf(body({ layoutVersion: undefined }))).not.toHaveProperty('layoutVersion');
    expect(() => overlayOf(null)).toThrow(SaleConfigUnavailable);
    expect(() => overlayOf(body({ rev: 0 }))).toThrow(SaleConfigUnavailable);
    expect(() => overlayOf(body({ saleEndsAtMs: -1 }))).toThrow(SaleConfigUnavailable);
    expect(() => overlayOf(body({ salePolicy: 'x' }))).toThrow(SaleConfigUnavailable);
    expect(() => overlayOf(body({ eligLists: ['a', 'a'] }))).toThrow(SaleConfigUnavailable);
  });
});
