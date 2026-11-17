// W9-fix3 F5(HOT-240 '큰 본문 칸막이를 인증 가드보다 먼저…', 시험 담당 w9f3-test 2026-11-17): core 좌석맵 저장(PUT /v1/partner/productions/{id}/seatmap,
// 칸막이 partner-seatmap-save 한도 2, 본문 상한 12MiB)은 신원 없는 요청에 자리를 주지 않고 본문을 기다리지 않는다.
// 정본: docs/api/guidelines.md §7 '본문을 읽기 전의 차례'·'본문을 다 읽기 전에 답하면 연결을 닫는다', docs/architecture.md §5 'REST 포트' 행
// (내부 HTTP를 부르는 파드는 게이트웨이를 거치지 않고 core-svc REST 포트에 닿는다). 실제 소켓으로 머리만 보낸다(본문은 보내지 않는다).
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { LAYOUT_SAVE_BULKHEAD } from '../src/modules/catalog/domain/seatmap-layout.js';
import { MemoryCatalogRepository, MemoryPublicFileStore } from '../src/modules/catalog/index.js';
import { FakeIdentity, NOW_MS, quiet } from './support.js';

let svc: Awaited<ReturnType<typeof createService>>;
let port: number;
const repo = new MemoryCatalogRepository();
const identity = new FakeIdentity();
const TENANT = randomUUID();
const PROD = randomUUID();
const URL_PATH = `/v1/partner/productions/${PROD}/seatmap`;

const sq = (x: number, w: number): [number, number][] => [
  [x, 0],
  [x + w, 0],
  [x + w, w],
  [x, w],
];
const body = {
  canvas: { width: 1000, height: 600 },
  sections: [{ sectionId: 'A', name: 'A구역', shape: { kind: 'POLYGON', points: sq(0, 400) }, tierId: 'R', seats: [1, 2].map((n) => ({ seatId: `A-1-${n}`, row: '1', number: n, x: n * 10, y: 10 })) }],
  priceTiers: [{ tierId: 'R', name: 'R석', price: 150_000 }],
};

beforeAll(async () => {
  repo.sellerNames.set(TENANT, '(주)피켓공연');
  repo.productions.set(PROD, { id: PROD, promoterId: TENANT, placeId: null, title: '겨울 콘서트', genre: '콘서트', saleReview: 'DRAFT', saleApprovedAt: null });
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, catalog: repo, media: { publicFiles: new MemoryPublicFileStore() } }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW_MS }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
  await svc.http.listen({ port: 0, host: '127.0.0.1' });
  port = (svc.http.server.address() as { port: number }).port;
});
afterAll(async () => {
  await svc?.close();
});

/** 옳은 partner 요청(본문까지, inject) */
const save = () => svc.http.inject({ method: 'PUT', url: URL_PATH, headers: { ...identity.partner(TENANT, 'partner_member'), 'content-type': 'application/json', 'if-match': '"0"' }, payload: JSON.stringify(body) });

interface Raw {
  socket: Socket;
  /** 받은 첫 응답의 상태 줄·머리(시간 안에 없으면 undefined) */
  head(waitMs: number): Promise<{ status: number; headers: Record<string, string> } | undefined>;
}

/** 머리만 보낸 PUT(선언 길이 1000, 본문은 보내지 않는다) */
async function headOnly(headers: Record<string, string>): Promise<Raw> {
  const socket = connect(port, '127.0.0.1');
  await new Promise<void>((r) => socket.once('connect', () => r()));
  let text = '';
  socket.on('data', (c: Buffer) => (text += c.toString('latin1')));
  socket.on('error', () => undefined);
  const lines = [`PUT ${URL_PATH} HTTP/1.1`, 'Host: 127.0.0.1', 'Content-Type: application/json', 'Content-Length: 1000', 'If-Match: "0"', ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', ''];
  socket.write(lines.join('\r\n'));
  return {
    socket,
    async head(waitMs) {
      const until = Date.now() + waitMs;
      while (!text.includes('\r\n\r\n') && Date.now() < until && !socket.destroyed) await new Promise((r) => setTimeout(r, 10));
      const end = text.indexOf('\r\n\r\n');
      if (end < 0) return undefined;
      const [statusLine, ...rest] = text.slice(0, end).split('\r\n');
      const h: Record<string, string> = {};
      for (const l of rest) {
        const i = l.indexOf(':');
        if (i > 0) h[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
      }
      return { status: Number(statusLine!.split(' ')[1]), headers: h };
    },
  };
}

describe('W9F3 F5 core 좌석맵 저장 칸막이', () => {
  test('W9F3 F5 core 좌석맵 저장은 신원 없이 칸막이를 쥐지 못한다 [ASVS v5.0.0-8.3.1] [ASVS v5.0.0-15.2.2]', async () => {
    expect(LAYOUT_SAVE_BULKHEAD.limit).toBe(2);
    // 한도만큼(둘) 신원 없는 요청을 머리만 보낸다: 본문 없이 바로 401이고 연결을 닫는다
    const anon = [await headOnly({}), await headOnly({})];
    try {
      for (const [i, a] of anon.entries()) {
        const r = await a.head(1_500);
        expect(r?.status, `신원 없음 ${i + 1}: 본문 없이 바로 답해야 한다`).toBe(401);
        expect(r?.headers.connection?.toLowerCase(), `신원 없음 ${i + 1}: Connection`).toBe('close');
      }
      // 이어 옳은 요청은 자리를 얻는다(429가 아니다)
      const ok = await save();
      expect(ok.statusCode, '옳은 요청').not.toBe(429);
      expect(ok.statusCode, '옳은 요청').not.toBe(401);
    } finally {
      for (const a of anon) a.socket.destroy();
    }

    // 옳은 요청 둘이 머리만 보내 자리를 다 쥔 동안에도, 신원 없는 요청은 429가 아니라 401이다(자리 잡기 전에 신원을 본다)
    const holders = [await headOnly(identity.partner(TENANT, 'partner_member')), await headOnly(identity.partner(TENANT, 'partner_admin'))];
    try {
      let full = false;
      for (let i = 0; i < 100 && !full; i++) {
        full = (await save()).statusCode === 429;
        if (!full) await new Promise((r) => setTimeout(r, 10));
      }
      expect(full, '자리를 다 붙잡지 못했다(시험 준비)').toBe(true);
      const late = await headOnly({});
      try {
        expect((await late.head(1_500))?.status, '자리가 찬 때의 신원 없는 요청').toBe(401);
      } finally {
        late.socket.destroy();
      }
    } finally {
      for (const h of holders) h.socket.destroy();
    }
  }, 20_000);
});
