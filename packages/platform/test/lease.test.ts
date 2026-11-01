// 쿠버네티스 Lease로 릴레이 리더 하나 뽑기(openspec 변경 add-idempotency-and-outbox 결정 10, ADR-0116 결정 2).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { LEASE_DEFAULTS, LeaseElector, fakeClock, kubernetesLeaseApi, type FakeClock, type LeaseApi, type LeaseRecord, type LeaseSpec } from '../src/index.js';

/** resourceVersion으로 겨루는 메모리 Lease(API 서버와 같은 낙관적 동시성) */
function memoryLease() {
  let rec: LeaseRecord | undefined;
  let version = 0;
  let down = false;
  const api: LeaseApi = {
    async get() {
      if (down) throw new Error('API 서버 없음');
      return rec ? { ...rec } : undefined;
    },
    async create(spec: LeaseSpec) {
      if (down) throw new Error('API 서버 없음');
      if (rec) return 'conflict';
      rec = { ...spec, resourceVersion: String(++version) };
      return { ...rec };
    },
    async update(spec: LeaseSpec, resourceVersion: string) {
      if (down) throw new Error('API 서버 없음');
      if (!rec || rec.resourceVersion !== resourceVersion) return 'conflict';
      rec = { ...spec, resourceVersion: String(++version) };
      return { ...rec };
    },
  };
  return {
    api,
    record: () => rec,
    setDown: (v: boolean) => {
      down = v;
    },
  };
}

const elector = (api: LeaseApi, identity: string, clock: FakeClock) => new LeaseElector({ api, identity, clock });

describe('리더 뽑기', () => {
  test('FND080_Lease기본값은_12초8초2초이고_이어받기는15초안이다', () => {
    expect(LEASE_DEFAULTS).toEqual({ leaseDurationMs: 12_000, renewDeadlineMs: 8_000, retryPeriodMs: 2_000 });
    expect(LEASE_DEFAULTS.leaseDurationMs + LEASE_DEFAULTS.retryPeriodMs).toBeLessThanOrEqual(15_000);
    expect(LEASE_DEFAULTS.renewDeadlineMs).toBeLessThan(LEASE_DEFAULTS.leaseDurationMs);
  });

  test('FND080_두복제가함께시작하면_하나만리더다', async () => {
    const clock = fakeClock();
    const m = memoryLease();
    const a = elector(m.api, 'relay-a', clock);
    const b = elector(m.api, 'relay-b', clock);
    await Promise.all([a.step(), b.step()]);
    expect([a.isLeader(), b.isLeader()].filter(Boolean)).toHaveLength(1);
    expect(m.record()?.holderIdentity).toBe(a.isLeader() ? 'relay-a' : 'relay-b');
  });

  test('FND080_리더가갱신을멈추면_Lease기간이지난뒤다른복제가리더가된다', async () => {
    const clock = fakeClock();
    const m = memoryLease();
    const a = elector(m.api, 'relay-a', clock);
    const b = elector(m.api, 'relay-b', clock);
    await a.step();
    await b.step();
    expect(a.isLeader()).toBe(true);
    expect(b.isLeader()).toBe(false);
    // a가 멈췄다(더 부르지 않는다). b는 2초마다 다시 본다
    let waited = 0;
    while (!b.isLeader()) {
      clock.advance(LEASE_DEFAULTS.retryPeriodMs);
      waited += LEASE_DEFAULTS.retryPeriodMs;
      await b.step();
      expect(waited).toBeLessThanOrEqual(15_000);
    }
    expect(waited).toBeGreaterThanOrEqual(LEASE_DEFAULTS.leaseDurationMs);
    expect(m.record()).toMatchObject({ holderIdentity: 'relay-b', leaseTransitions: 1 });
  });

  test('FND080_리더는갱신하는동안_계속리더다', async () => {
    const clock = fakeClock();
    const m = memoryLease();
    const a = elector(m.api, 'relay-a', clock);
    const b = elector(m.api, 'relay-b', clock);
    await a.step();
    for (let i = 0; i < 20; i += 1) {
      clock.advance(LEASE_DEFAULTS.retryPeriodMs);
      await a.step();
      await b.step();
      expect(a.isLeader()).toBe(true);
      expect(b.isLeader()).toBe(false);
    }
  });

  test('FND080_갱신한도동안갱신하지못하면_남이잡기전에스스로내려온다', async () => {
    const clock = fakeClock();
    const m = memoryLease();
    const a = elector(m.api, 'relay-a', clock);
    await a.step();
    m.setDown(true);
    clock.advance(LEASE_DEFAULTS.retryPeriodMs);
    await a.step();
    expect(a.isLeader()).toBe(true);
    clock.advance(LEASE_DEFAULTS.renewDeadlineMs);
    expect(a.isLeader()).toBe(false);
    await a.step();
    expect(a.isLeader()).toBe(false);
  });

  test('FND080_같은판의Lease를함께고치면_하나만이긴다', async () => {
    const clock = fakeClock();
    const m = memoryLease();
    const a = elector(m.api, 'relay-a', clock);
    await a.step();
    await a.release();
    // 놓은 Lease(1초)는 다음 시도에서 둘이 겨룬다
    clock.advance(1_000);
    const b = elector(m.api, 'relay-b', clock);
    const c = elector(m.api, 'relay-c', clock);
    await Promise.all([b.step(), c.step()]);
    expect([b.isLeader(), c.isLeader()].filter(Boolean)).toHaveLength(1);
  });

  test('FND080_멈출때_Lease를놓아_다른복제가곧잡는다', async () => {
    const clock = fakeClock();
    const m = memoryLease();
    const a = elector(m.api, 'relay-a', clock);
    const b = elector(m.api, 'relay-b', clock);
    await a.step();
    await b.step();
    await a.release();
    expect(a.isLeader()).toBe(false);
    expect(m.record()).toMatchObject({ holderIdentity: null, leaseDurationSeconds: 1 });
    clock.advance(LEASE_DEFAULTS.retryPeriodMs);
    await b.step();
    expect(b.isLeader()).toBe(true);
  });

  test('FND080_남의Lease만료는_상대가적은시각이아니라_내가본시점부터센다', async () => {
    const clock = fakeClock();
    const m = memoryLease();
    // 시계가 10분 늦은 노드의 리더가 갱신 시각을 옛날로 적어도, 내가 그 기록이 바뀐 것을 본 때부터 Lease 기간을 센다
    const skewed = fakeClock({ now: clock.now() - 600_000 });
    const a = elector(m.api, 'relay-a', skewed);
    const b = elector(m.api, 'relay-b', clock);
    await a.step();
    await b.step();
    expect(b.isLeader()).toBe(false);
    clock.advance(LEASE_DEFAULTS.retryPeriodMs);
    skewed.advance(LEASE_DEFAULTS.retryPeriodMs);
    await a.step();
    await b.step();
    expect(b.isLeader()).toBe(false);
  });
});

describe('쿠버네티스 Lease API 모양', () => {
  let server: Server;
  let base: string;
  const seen: { method: string; url: string; auth?: string; body?: unknown }[] = [];
  let stored: Record<string, unknown> | undefined;
  let rv = 0;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
        seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
        const send = (code: number, b: unknown) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(b));
        };
        const meta = (body?.metadata ?? {}) as Record<string, unknown>;
        if (req.method === 'GET') return stored ? send(200, stored) : send(404, { kind: 'Status', code: 404 });
        if (req.method === 'POST') {
          if (stored) return send(409, { kind: 'Status', code: 409, reason: 'AlreadyExists' });
          stored = { ...body, metadata: { ...meta, resourceVersion: String(++rv) } };
          return send(201, stored);
        }
        if (req.method === 'PUT') {
          if (!stored || (stored.metadata as Record<string, unknown>).resourceVersion !== meta.resourceVersion) return send(409, { kind: 'Status', code: 409, reason: 'Conflict' });
          stored = { ...body, metadata: { ...meta, resourceVersion: String(++rv) } };
          return send(200, stored);
        }
        send(405, {});
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  test('FND080_Lease를_coordination_v1경로로읽고만들고_resourceVersion으로고친다', async () => {
    let token = 'tok-1';
    const api = kubernetesLeaseApi({ baseUrl: base, namespace: 'purchase', name: 'purchase-outbox-relay', token: () => token });
    expect(await api.get()).toBeUndefined();
    const spec: LeaseSpec = { holderIdentity: 'relay-a', leaseDurationSeconds: 12, acquireTime: '2026-11-01T00:00:00.123000Z', renewTime: '2026-11-01T00:00:00.123000Z', leaseTransitions: 0 };
    const created = await api.create(spec);
    expect(created).toMatchObject({ ...spec, resourceVersion: '1' });
    expect(await api.create(spec)).toBe('conflict');
    token = 'tok-2';
    const updated = await api.update({ ...spec, renewTime: '2026-11-01T00:00:02.000000Z' }, '1');
    expect(updated).toMatchObject({ renewTime: '2026-11-01T00:00:02.000000Z', resourceVersion: '2' });
    expect(await api.update(spec, '1')).toBe('conflict');
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET /apis/coordination.k8s.io/v1/namespaces/purchase/leases/purchase-outbox-relay',
      'POST /apis/coordination.k8s.io/v1/namespaces/purchase/leases',
      'POST /apis/coordination.k8s.io/v1/namespaces/purchase/leases',
      'PUT /apis/coordination.k8s.io/v1/namespaces/purchase/leases/purchase-outbox-relay',
      'PUT /apis/coordination.k8s.io/v1/namespaces/purchase/leases/purchase-outbox-relay',
    ]);
    // 서비스 계정 토큰은 부를 때마다 다시 읽는다(돌려 바뀐다)
    expect(seen[0]!.auth).toBe('Bearer tok-1');
    expect(seen[3]!.auth).toBe('Bearer tok-2');
    expect(seen[1]!.body).toMatchObject({ apiVersion: 'coordination.k8s.io/v1', kind: 'Lease', metadata: { name: 'purchase-outbox-relay', namespace: 'purchase' }, spec });
  });

  test('FND080_리뷰_응답도중연결이끊기면_Lease부르기가멈추지않고실패한다', async () => {
    // 확인 리뷰 2026-11-01: 머리를 받은 뒤 연결이 끊기면 'end'도 요청 오류도 오지 않아 step()이 영원히 멈췄다(리더가 없어지고 stop()도 멈춤)
    const cut = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
      res.write('{"metadata":');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    await new Promise<void>((r) => cut.listen(0, '127.0.0.1', r));
    try {
      const api = kubernetesLeaseApi({ baseUrl: `http://127.0.0.1:${(cut.address() as AddressInfo).port}`, namespace: 'n', name: 'l', token: () => 't', timeoutMs: 500 });
      const started = Date.now();
      await expect(api.get()).rejects.toThrow(/Lease API/);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await new Promise<void>((r) => cut.close(() => r()));
    }
  });

  test('FND080_리뷰_응답이오다가멈추면_전체시간한도에서실패한다', async () => {
    const stall = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
      const t = setInterval(() => res.write(' '), 100);
      res.on('close', () => clearInterval(t));
    });
    await new Promise<void>((r) => stall.listen(0, '127.0.0.1', r));
    try {
      const api = kubernetesLeaseApi({ baseUrl: `http://127.0.0.1:${(stall.address() as AddressInfo).port}`, namespace: 'n', name: 'l', token: () => 't', timeoutMs: 500 });
      const started = Date.now();
      await expect(api.get()).rejects.toThrow(/Lease API/);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      stall.closeAllConnections();
      await new Promise<void>((r) => stall.close(() => r()));
    }
  });

  test('FND080_Lease시각은_마이크로초여섯자리의RFC3339다', async () => {
    const clock = fakeClock({ now: Date.parse('2026-11-01T00:00:00.123Z') });
    const m = memoryLease();
    const a = new LeaseElector({ api: m.api, identity: 'relay-a', clock });
    await a.step();
    expect(m.record()?.renewTime).toBe('2026-11-01T00:00:00.123000Z');
  });
});
