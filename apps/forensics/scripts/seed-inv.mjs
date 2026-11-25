// 조사 갈래 시험 시드(docs/features/forensic-replay.md §5.5, F-04-10 계획 §4).
// F-04-9의 같은 생성기(시드 고정)를 돌려 inv 표 넷과 운영 DB 계정·주문 모양을 만든다. 로컬·CI·데모에서만 쓴다.
// 심어 둔 묶음 여섯(결제 수단 9계정·대기열 우회 1·가족 2·이동통신 같은 IP 50·행동만 비슷한 10·약한 결제 연결 2)을 넣는다.
// 명령: node apps/forensics/scripts/seed-inv.mjs --event <ID> --performance-date 2026-12-01 [--write <ClickHouse URL>]
//   쓰기는 inv_ingest 사용자(PEAKET_INV_INGEST_PASSWORD)로 한다. 파일만 만들려면 --out <경로>.
import { writeFileSync } from 'node:fs';
import { defaultParams, generateScenario, SALE_START_ISO } from '../src/lib/forensics/scenario.ts';
import { EVENT_KIND, NO_SEAT } from '../src/lib/forensics/events.ts';

const RESULT_NAME = ['NONE', 'HELD', 'CONFLICT', 'LIMIT', 'ERROR', 'PAID', 'FAILED'];
const NET_TYPE_NAME = { 1: 'MOBILE', 2: 'WIFI', 3: 'HOSTING', 4: 'PROXY' };
const KIND_STEP = {
  [EVENT_KIND.QUEUE_ENTER]: 'QUEUE_ENTER',
  [EVENT_KIND.ADMIT]: 'ADMIT',
  [EVENT_KIND.HOLD_TRY]: 'HOLD_TRY',
  [EVENT_KIND.HOLD_END]: 'HOLD_END',
  [EVENT_KIND.PAY_TRY]: 'PAY_TRY',
  [EVENT_KIND.SALE]: 'SALE',
  [EVENT_KIND.PAY_FAIL]: 'PAY_TRY',
};

const uuid = (prefix, n) => `${prefix}000-0000-7000-8000-${String(n).padStart(12, '0').slice(-12)}`;
const iso = (ms) => new Date(ms).toISOString();
const retainUntil = (date) => {
  const t = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(t)) throw new Error(`공연일 모양이 틀렸다: ${date}`);
  return new Date(t + 30 * 24 * 60 * 60 * 1000).toISOString();
};

/**
 * 같은 인자면 같은 행이 나온다.
 * @param {{seed?:string,eventId:string,performanceDate:string,seats?:number,queueSize?:number,windowMs?:number,botRatio?:number}} o
 */
export function buildInvSeed(o) {
  const {
    seed = 'seed-A',
    eventId,
    performanceDate,
    seats = 1_000,
    queueSize = 200,
    windowMs = 120_000,
    botRatio = 0.1,
  } = o;
  if (!eventId) throw new Error('eventId가 필요하다');
  const retain = retainUntil(performanceDate);
  const ingestedAt = `${performanceDate}T09:00:00.000Z`;
  const params = { ...defaultParams('sports', seed), seats, queueSize, windowMs, botRatio };
  const scenario = generateScenario(params);
  const start = Date.parse(SALE_START_ISO);

  const requests = [];
  const steps = [];
  const behaviors = [];
  const links = [];
  const accounts = [];
  const orders = [];

  const accountOf = (session) => (session % 3 === 0 ? `acct-${session}` : '');
  const pidOf = (session) => `pid-${session}`;
  const journeyOf = (session) => uuid('2000', session);
  const deviceOf = (group) => (group > 0 ? `k1.device-${group}` : '');
  const ipOf = (session, net) => {
    const host = 10 + (session % 200);
    if (net === 3 || net === 4) return `192.0.2.${host}`;
    if (net === 2) return `198.51.100.${host}`;
    return `203.0.113.${host}`;
  };
  const netClassOf = (net) => (net === 3 ? 'HOSTING' : net === 4 ? 'PROXY' : 'OTHER');
  const netClassFromName = (net) => (net === 3 ? 'HOSTING' : net === 4 ? 'PROXY' : 'OTHER');

  const link = (eventId2, kind, value, account, pid, journey, source, at) => ({
    event_id: eventId2,
    kind,
    value,
    account_id: account,
    pid,
    journey_id: journey,
    source,
    first_seen_at: iso(at),
    last_seen_at: iso(at),
    ingested_at: ingestedAt,
    retain_until: retain,
    ingest_rank: String(18_446_744_073_709_551_615n - BigInt(Date.parse(ingestedAt))),
  });
  const step = (eventId2, sourceKey, at, journey, name, row = {}) => ({
    event_id: eventId2,
    source_key: sourceKey,
    ts: iso(at),
    ingested_at: ingestedAt,
    journey_id: journey,
    step: name,
    pid: '',
    account_id: '',
    queue_entry_id: '',
    purchase_session_id: '',
    order_id: '',
    ticket_id: '',
    seat_ids: [],
    held_at: '',
    result: '',
    verify_route: '',
    payment_method_ref: '',
    card_bin: '',
    ref_missing: 0,
    retain_until: retain,
    ingest_rank: String(18_446_744_073_709_551_615n - BigInt(Date.parse(ingestedAt))),
    ...row,
  });
  const request = (eventId2, requestId, at, net, account, pid, journey, extra = {}) => ({
    event_id: eventId2,
    request_id: requestId,
    ts: iso(at),
    ingested_at: ingestedAt,
    journey_id: journey,
    gateway: 'GW_QUEUE',
    route_kind: 'QUEUE_ENTER',
    status: 200,
    account_id: account,
    pid,
    ip: ipOf(pid.length, net),
    asn: net === 3 ? 16509 : net === 4 ? 9009 : 64500,
    net_class: netClassFromName(net),
    ja4: '',
    edge_bot_labels: [],
    device_ref: '',
    retain_until: retain,
    ingest_rank: String(18_446_744_073_709_551_615n - BigInt(Date.parse(ingestedAt))),
    ...extra,
  });

  // 생성기 사건 → inv_step·요청·행동·연결
  for (let i = 0; i < scenario.columns.kind.length; i += 1) {
    const session = scenario.columns.session[i];
    const kind = scenario.columns.kind[i];
    const name = KIND_STEP[kind];
    if (!name) continue;
    const at = start + scenario.columns.t_ms[i];
    const eventKey = uuid('3000', i + 1);
    const seat = scenario.columns.seat[i];
    const account = accountOf(session);
    const pid = pidOf(session);
    const journey = journeyOf(session);
    const net = scenario.columns.net_type[i];
    const result = kind === EVENT_KIND.PAY_FAIL ? 'FAILED' : RESULT_NAME[scenario.columns.result[i]] ?? 'NONE';
    steps.push(
      step(eventId, `${eventKey}:${name}`, at, journey, name, {
        pid,
        account_id: account,
        seat_ids: seat !== NO_SEAT ? [`seat-${seat}`] : [],
        held_at: name === 'HOLD_TRY' ? iso(at) : '',
        result,
        ref_missing: 0,
      }),
    );
    if (i === 0 || scenario.columns.session[i - 1] !== session) {
      requests.push(request(eventId, `req-${session}`, at, net, account, pid, journey));
      links.push(link(eventId, 'PID', pid, account, pid, journey, 'investigation.requests', at));
      if (account) {
        links.push(link(eventId, 'ACCOUNT', account, account, pid, journey, 'trade.orders', at));
        accounts.push({ accountId: account, createdAt: iso(at) });
      }
      const device = deviceOf(scenario.columns.device_group[i]);
      if (device) links.push(link(eventId, 'DEVICE', device, account, pid, journey, 'identity', at));
      if (session % 11 === 0) links.push(link(eventId, 'CONTACT', `k1.contact-${session % 5}`, account, pid, journey, 'identity', at));
      if (session % 5 === 0) links.push(link(eventId, 'PAYMENT_METHOD', `k1.pay-${session % 7}`, account, pid, journey, 'trade.payments', at));
      behaviors.push({
        event_id: eventId,
        event_key: eventKey,
        ts: iso(at),
        ingested_at: ingestedAt,
        journey_id: journey,
        pid,
        screen: 'SEAT',
        device_ref: device,
        ref_missing: 0,
        net_class: netClassOf(net),
        asn: net === 3 ? 16509 : net === 4 ? 9009 : 64500,
        v: 1,
        window_ms: 60_000,
        pointer_moves: 12,
        pointer_entropy: 1.5,
        input_interval_mean_ms: 120,
        input_interval_std_ms: 10,
        scroll_events: 2,
        scroll_distance_px: 300,
        retain_until: retain,
        ingest_rank: String(18_446_744_073_709_551_615n - BigInt(Date.parse(ingestedAt))),
      });
    }
    if (name === 'SALE') orders.push({ orderId: `order-${session}`, accountId: account, eventId, seatCount: 1 });
  }

  // ① 결제 수단 연결값 하나로 9계정이 27장(1인 한도 4장) — 한 묶음, 점수 범주 높음
  const paymentNine = { paymentRef: 'k1.pay-planted-nine', accountIds: [], saleCount: 27 };
  for (let n = 0; n < 9; n += 1) {
    const account = `plant-acct-pay${n}`;
    const pid = `plant-pid-pay${n}`;
    const journey = uuid('4000', n + 1);
    paymentNine.accountIds.push(account);
    links.push(link(eventId, 'PAYMENT_METHOD', paymentNine.paymentRef, account, pid, journey, 'trade.payments', start));
    links.push(link(eventId, 'ACCOUNT', account, account, pid, journey, 'trade.orders', start));
    links.push(link(eventId, 'PID', pid, account, pid, journey, 'investigation.requests', start));
    for (let k = 0; k < 3; k += 1) {
      const at = start + 60_000 + (n * 3 + k) * 100;
      steps.push(step(eventId, `${uuid('5000', n * 3 + k + 1)}:SALE`, at, journey, 'SALE', { account_id: account, pid, seat_ids: [`plant-seat-${n}-${k}`], result: 'PAID' }));
    }
  }

  // ② 입장 토큰 없이 홀드한 계정 하나 — 계정 하나짜리 후보(대기열 우회)
  const bypass = { accountId: 'plant-acct-bypass' };
  steps.push(step(eventId, `${uuid('5100', 1)}:HOLD_TRY`, start + 30_000, uuid('4100', 1), 'HOLD_TRY', { account_id: bypass.accountId, pid: 'plant-pid-bypass', seat_ids: ['plant-seat-bypass'], held_at: iso(start + 30_000), result: 'HELD' }));

  // ③ 같은 연락처 해시를 쓰는 가족 두 계정(4장, 한도 이내)
  const family = { contactRef: 'k1.contact-planted-family', accountIds: ['plant-acct-family0', 'plant-acct-family1'] };
  for (const account of family.accountIds) {
    const pid = `plant-pid-${account.slice(-7)}`;
    links.push(link(eventId, 'CONTACT', family.contactRef, account, pid, uuid('4200', account.endsWith('0') ? 1 : 2), 'identity', start));
  }

  // ④ 이동통신 망의 같은 IP를 쓴 서로 다른 계정 50개 — 약한 연결이라 묶이지 않는다
  const mobile = { ip: '203.0.113.77', accountIds: [] };
  for (let n = 0; n < 50; n += 1) {
    const account = `plant-acct-mobile${n}`;
    mobile.accountIds.push(account);
    requests.push(request(eventId, `req-mobile-${n}`, start + n, 1, account, `plant-pid-mobile${n}`, uuid('4300', n + 1), { ip: mobile.ip, net_class: 'OTHER', asn: 64500 }));
  }

  // ⑤ 화면별 행동 요약만 비슷한 계정 10개 — 행동 요약은 계정을 잇지 않는다
  const similarBehavior = { accountIds: [], pids: [] };
  for (let n = 0; n < 10; n += 1) {
    const account = `plant-acct-beh${n}`;
    const pid = `plant-pid-beh${n}`;
    similarBehavior.accountIds.push(account);
    similarBehavior.pids.push(pid);
    behaviors.push({
      event_id: eventId,
      event_key: uuid('5200', n + 1),
      ts: iso(start + n),
      ingested_at: ingestedAt,
      journey_id: uuid('4400', n + 1),
      pid,
      screen: 'SEAT',
      device_ref: '',
      ref_missing: 0,
      net_class: 'OTHER',
      asn: 64500,
      v: 1,
      window_ms: 60_000,
      pointer_moves: 20,
      pointer_entropy: 1.25,
      input_interval_mean_ms: 100,
      input_interval_std_ms: 5,
      scroll_events: 1,
      scroll_distance_px: 100,
      retain_until: retain,
      ingest_rank: String(18_446_744_073_709_551_615n - BigInt(Date.parse(ingestedAt))),
    });
  }

  // ⑥ 행동 요약이 비슷하고 약한 연결이 한 종류뿐인 계정 둘(같은 결제 수단) — 묶이지 않는다
  const weakPair = { paymentRef: 'k1.pay-planted-weak', accountIds: ['plant-acct-weak0', 'plant-acct-weak1'] };
  for (const account of weakPair.accountIds) {
    const pid = `plant-pid-${account.slice(-5)}`;
    links.push(link(eventId, 'PAYMENT_METHOD', weakPair.paymentRef, account, pid, uuid('4500', account.endsWith('0') ? 1 : 2), 'trade.payments', start));
  }

  return {
    eventId,
    performanceDate,
    params,
    requests,
    steps,
    behaviors,
    links,
    accounts,
    orders,
    bundles: { paymentNine, bypass, family, mobile, similarBehavior, weakPair },
    stats: {
      sessions: scenario.truth.sessions.length + 9 + 1 + 2 + 50 + 10 + 2,
      events: steps.length,
      requests: requests.length,
      behaviors: behaviors.length,
      links: links.length,
    },
  };
}

/** ClickHouse에 JSONEachRow로 쓴다(시험·로컬 전용). */
export async function writeInvSeed(seed, o) {
  const auth = { 'x-clickhouse-user': o.user ?? 'inv_ingest', 'x-clickhouse-key': o.password ?? '' };
  for (const [table, rows] of [
    ['inv.inv_request', seed.requests],
    ['inv.inv_step', seed.steps],
    ['inv.inv_behavior', seed.behaviors],
    ['inv.inv_link', seed.links],
  ]) {
    if (!rows.length) continue;
    const body = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    // ISO 8601 시각을 그대로 받으려면 date_time_input_format=best_effort가 필요하다(F-04-11 통합 시험에서 확인).
    const query = `?query=${encodeURIComponent(`INSERT INTO ${table} FORMAT JSONEachRow`)}&date_time_input_format=best_effort`;
    const res = await fetch(`${o.url.replace(/\/$/, '')}/${query}`, { method: 'POST', headers: auth, body });
    if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll('\\', '/')}`).href) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const seed = buildInvSeed({
    eventId: arg('event'),
    performanceDate: arg('performance-date'),
    seed: arg('seed', 'seed-A'),
  });
  const out = arg('out');
  if (out) writeFileSync(out, `${JSON.stringify(seed, null, 2)}\n`);
  const url = arg('write');
  if (url) await writeInvSeed(seed, { url, user: arg('user', 'inv_ingest'), password: process.env.PEAKET_INV_INGEST_PASSWORD ?? '' });
  process.stdout.write(`${JSON.stringify(seed.stats)}\n`);
}
