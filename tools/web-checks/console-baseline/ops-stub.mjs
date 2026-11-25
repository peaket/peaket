// F-03-6(FE-T29) 관제 API 대역. 실제 ops-svc는 PostgreSQL·identity-svc·Prometheus가 있어야 시작하므로
// Docker·kind를 쓰지 않는 동결 로컬 측정에서는 두 빌드에 **같은 값**을 내는 이 작은 서버를 쓴다.
// 경로·값 모양은 services/ops-svc/src/modules/live/domain/widgets.ts와 docs/api/openapi.yaml을 따른다.
// 값은 숫자·상태만 싣고 화면 글자는 위젯이 만든다. SSE는 위젯 키마다 event: widget 한 번과 10초 하트비트다.
import { createServer } from 'node:http';
import { EVENT_ID } from './lib.mjs';

const AT = '2026-11-25T07:00:00.000Z';

const widgetValues = {
  'queue-admission-rate.summary': {
    widgetKey: 'queue-admission-rate.summary',
    source: 'prometheus',
    at: AT,
    eventId: EVENT_ID,
    ratio: 0.82,
    target: 1200,
    slotsUsed: 980,
    inFlight: 220,
    soonWaiting: 1500,
    series: [
      { at: '2026-11-25T06:58:00.000Z', ratio: 0.78 },
      { at: '2026-11-25T06:59:00.000Z', ratio: 0.8 },
      { at: '2026-11-25T07:00:00.000Z', ratio: 0.82 },
    ],
  },
  'purchase-pg-status.summary': {
    widgetKey: 'purchase-pg-status.summary',
    source: 'prometheus',
    at: AT,
    eventId: EVENT_ID,
    pgs: [
      { pg: 'toss', limitRatio: 0.42, circuitOpen: false, inflight: 12, saturatedPerMin: 0 },
      { pg: 'portone', limitRatio: 0.18, circuitOpen: false, inflight: 3, saturatedPerMin: 0 },
    ],
    series: [
      { at: '2026-11-25T06:59:00.000Z', pg: 'toss', limitRatio: 0.4 },
      { at: '2026-11-25T07:00:00.000Z', pg: 'toss', limitRatio: 0.42 },
    ],
  },
  'rt-sales.summary': {
    widgetKey: 'rt-sales.summary',
    source: 'clickhouse',
    at: AT,
    eventId: EVENT_ID,
    sold: 1820,
    remaining: 580,
    salesAmount: 145600000,
    ordersConfirmed: 860,
    ticketsIssued: 1720,
    waiting: 1500,
    queueEntries: 5000,
    sections: [
      { sectionId: 'A', sold: 620, remaining: 100 },
      { sectionId: 'B', sold: 480, remaining: 220 },
      { sectionId: 'C', sold: 720, remaining: 260 },
    ],
    freshnessSeconds: 1,
    degraded: false,
    tradeGap: false,
  },
  'ops-readiness.checklist': {
    widgetKey: 'ops-readiness.checklist',
    source: 'prometheus',
    at: AT,
    eventId: EVENT_ID,
    items: [
      { key: 'prewarm', group: 'required', status: 'pass', value: 12, unit: 'replicas', at: AT },
      { key: 'datastores', group: 'required', status: 'pass', at: AT },
      { key: 'payment-provider', group: 'required', status: 'pass', at: AT },
      { key: 'identity-providers', group: 'required', status: 'pass', at: AT },
      { key: 'cdn-limits', group: 'required', status: 'pass', at: AT },
      { key: 'synthetic', group: 'required', status: 'pass', at: AT },
      { key: 'oncall-test', group: 'required', status: 'pass', at: AT },
      { key: 'clock-offset', group: 'required', status: 'pass', value: 4, unit: 'ms', at: AT },
      { key: 'credentials', group: 'required', status: 'pass', at: AT },
      { key: 'cross-region-backup', group: 'required', status: 'pass', at: AT },
      { key: 'deployments', group: 'required', status: 'pass', at: AT },
      { key: 'freeze-window', group: 'required', status: 'pass', at: AT },
      { key: 'managed-maintenance', group: 'required', status: 'pass', at: AT },
      { key: 'cdn-hit-ratio', group: 'recommended', status: 'pass', value: 0.93, at: AT },
      { key: 'demand-forecast', group: 'recommended', status: 'pass', at: AT },
    ],
    preview: { verdict: 'go', failedRequired: [], failedRecommended: [] },
  },
  'ops-budget.journeys': {
    widgetKey: 'ops-budget.journeys',
    source: 'prometheus',
    at: AT,
    eventId: EVENT_ID,
    journeys: [
      { journey: 'detail', linked: false, allowed: 100, used: 20, remaining: 80, burnShort: 0.4, burnLong: 0.5 },
      { journey: 'queue_entry', linked: false, allowed: 100, used: 30, remaining: 70, burnShort: 0.7, burnLong: 0.6 },
      { journey: 'queue_state', linked: false, allowed: 100, used: 22, remaining: 78, burnShort: 0.3, burnLong: 0.4 },
      { journey: 'hold', linked: true, allowed: 75, used: 18, remaining: 57, burnShort: 0.9, burnLong: 0.8 },
      { journey: 'seat_status', linked: true, allowed: 75, used: 16, remaining: 59, burnShort: 0.8, burnLong: 0.7 },
      { journey: 'payment_accept', linked: true, allowed: 75, used: 12, remaining: 63, burnShort: 0.6, burnLong: 0.6 },
      { journey: 'payment_confirm', linked: true, allowed: 75, used: 9, remaining: 66, burnShort: 0.5, burnLong: 0.4 },
    ],
  },
  'ops-saturation.summary': {
    widgetKey: 'ops-saturation.summary',
    source: 'prometheus',
    at: AT,
    eventId: EVENT_ID,
    level: 'ok',
    cpu: { value: 0.31, level: 'ok' },
    redisMemory: { value: 0.44, level: 'ok' },
    kafkaLag: { value: 120, level: 'ok' },
    eventLoop: { value: 0.012, level: 'ok' },
  },
  'ops-diagnostics.summary': {
    widgetKey: 'ops-diagnostics.summary',
    source: 'prometheus',
    at: AT,
    eventId: EVENT_ID,
    rumInpP75Ms: 88,
    rumLcpP75Ms: 930,
    slowQueries: [],
    network: 'ok',
  },
};

const readiness = {
  eventId: EVENT_ID,
  stage: 'live',
  schedule: { opensAt: '2026-11-25T11:00:00.000Z', saleEndsAt: '2026-11-25T13:00:00.000Z' },
  items: widgetValues['ops-readiness.checklist'].items,
  preview: { verdict: 'go', failedRequired: [], failedRecommended: [] },
  judgeableFrom: '2026-11-25T10:30:00.000Z',
  judgeableUntil: '2026-11-25T10:40:00.000Z',
  lastJudgement: null,
};

const control = { kind: 'ok', targetNow: 1200, updatedAt: AT, since: null, inputStaleKinds: [], budgetHoldAt: null };

const problem = (res, status, type) => {
  res.writeHead(status, { 'content-type': 'application/problem+json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ type: `https://peaket.example/problems/${type}`, title: type, status }));
};

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

/** 이벤트스트림 하나를 연다. 위젯 값은 연결 직후 한 번씩 보내고, 10초마다 주석 줄(하트비트)을 보낸다 */
function openStream(res, stats) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 10000\n\n');
  stats.streams += 1;
  const hb = setInterval(() => {
    if (!res.writableEnded) res.write(': hb\n\n');
  }, 10_000);
  hb.unref?.();
  res.on('close', () => clearInterval(hb));
}

/** @returns {Promise<{ origin: string, close: () => Promise<void>, stats: { requests: number, streams: number, widgets: number, byPath: Record<string, number> } }>} */
export async function startOpsStub() {
  const stats = { requests: 0, streams: 0, widgets: 0, byPath: {} };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub.local');
    const path = url.pathname;
    stats.requests += 1;
    stats.byPath[path] = (stats.byPath[path] ?? 0) + 1;
    if (req.method !== 'GET' && req.method !== 'POST') return problem(res, 405, 'method-not-allowed');

    if (path === '/__stub/stats') return json(res, { ...stats, version: 'widgets-v1' });

    if (path === '/v1/ops/live') {
      openStream(res, stats);
      res.write(`id: 1\nevent: control\ndata: ${JSON.stringify(control)}\n\n`);
      return;
    }
    if (/^\/v1\/ops\/events\/[^/]+\/live$/.test(path)) {
      const keys = (url.searchParams.get('widgets') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const unknown = keys.filter((k) => !widgetValues[k]);
      if (keys.length === 0 || unknown.length > 0) return problem(res, 422, 'unknown-widget');
      openStream(res, stats);
      for (const key of keys) {
        stats.widgets += 1;
        res.write(`event: widget\ndata: ${JSON.stringify({ widgetKey: key, at: AT, value: widgetValues[key] })}\n\n`);
      }
      return;
    }
    if (/^\/v1\/ops\/events\/[^/]+\/readiness$/.test(path)) return json(res, readiness);
    if (path === '/v1/ops/alerts') return json(res, { items: [], seq: 0 });
    if (path === '/v1/ops/commands') return json(res, { items: [], nextCursor: null });
    if (path === '/v1/ops/auth/sessions/me') return json(res, { accountId: '0192f0a0-0000-7000-8000-000000000001', role: 'operator', displayName: '측정 운영자' });
    if (path === '/v1/ops/auth/access-tokens') return json(res, { accessToken: 'stub-access', expiresAt: '2099-01-01T00:00:00.000Z' });
    const widget = /^\/v1\/ops\/widgets\/([^/]+)$/.exec(path);
    if (widget) {
      const key = decodeURIComponent(widget[1]);
      const value = widgetValues[key];
      if (!value) return problem(res, 404, 'not-found');
      return json(res, value);
    }
    return problem(res, 404, 'not-found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    stats,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export { widgetValues, readiness, control };
