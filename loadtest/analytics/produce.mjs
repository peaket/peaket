// F-04-8 발생기(docs/review/plans/F-04-8.md §5.3). Kafka에 Avro 사건을 정해진 도착률로 낸다.
// 이 프로세스는 성공한 send만 센다. 최종 실패가 있으면 manifest에 남기고 종료 코드 1로 끝난다(실행 전체가 무효).
// 사용: node loadtest/analytics/produce.mjs --brokers 127.0.0.1:9092 --rate 2000 --duration 30 --out .cache/f048/x --shard 0 --shards 1
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { buildHotPlan, buildPlan, allocCounts } from './lib.mjs';
import { loadPlatform } from './modules.mjs';
import { contextOf, createEncoder, eventOf, partitionOf, resultOf, sumOf } from './records.mjs';
import { sleep } from './docker.mjs';

const USAGE = `사용: node loadtest/analytics/produce.mjs --brokers <host:port> --out <폴더> [--rate 2000] [--duration 30] [--shard 0] [--shards 1] [--partitions 6] [--hot --hot-rate 4500] [--background-events 11] [--partition-mode hash|spread] [--event-id <UUID>] [--start-at <epoch ms>]`;

function parseArgs(argv) {
  const o = { shard: 0, shards: 1, partitions: 6, duration: 30, rate: 0, hot: false, hotRate: 0, backgroundEvents: 11, partitionMode: 'hash' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a}에 값이 없다`);
      return v;
    };
    switch (a) {
      case '--brokers': o.brokers = val().split(','); break;
      case '--out': o.out = val(); break;
      case '--rate': o.rate = Number(val()); break;
      case '--duration': o.duration = Number(val()); break;
      case '--shard': o.shard = Number(val()); break;
      case '--shards': o.shards = Number(val()); break;
      case '--partitions': o.partitions = Number(val()); break;
      case '--hot': o.hot = true; break;
      case '--hot-rate': o.hotRate = Number(val()); break;
      case '--background-events': o.backgroundEvents = Number(val()); break;
      case '--partition-mode': o.partitionMode = val(); break;
      case '--event-id': o.eventId = val(); break;
      case '--background-event-ids': o.backgroundEventIds = JSON.parse(val()); break;
      case '--start-at': o.startAt = Number(val()); break;
      case '--run-id': o.runId = val(); break;
      case '--help': case '-h': o.help = true; break;
      default: throw new Error(`모르는 인자: ${a}`);
    }
  }
  if (o.help) return o;
  if (!Array.isArray(o.brokers) || o.brokers.length === 0) throw new Error('--brokers가 필요하다');
  if (!o.out) throw new Error('--out이 필요하다');
  if (!Number.isFinite(o.duration) || o.duration <= 0) throw new Error('--duration은 0보다 큰 수여야 한다');
  if (!Number.isInteger(o.shard) || o.shard < 0) throw new Error('--shard는 0 이상의 정수여야 한다');
  if (!Number.isInteger(o.shards) || o.shards < 1) throw new Error('--shards는 1 이상의 정수여야 한다');
  if (o.shard >= o.shards) throw new Error('--shard는 --shards보다 작아야 한다');
  if (!Number.isInteger(o.partitions) || o.partitions < 1) throw new Error('--partitions는 1 이상의 정수여야 한다');
  if (o.partitionMode !== 'hash' && o.partitionMode !== 'spread') throw new Error('--partition-mode는 hash 또는 spread다');
  if (o.hot) {
    if (!Number.isFinite(o.hotRate) || o.hotRate <= 0) throw new Error('--hot에는 --hot-rate가 필요하다');
    if (o.partitions < 2) throw new Error('--hot에는 --partitions 2 이상이 필요하다');
  } else if (!Number.isFinite(o.rate) || o.rate <= 0) {
    throw new Error('--rate는 0보다 큰 수여야 한다');
  }
  return o;
}

/** 각 종류의 건수를 샤드 수로 나눈다(합이 정확히 원래 건수) */
function shardCounts(totalCounts, shards) {
  const weights = Object.fromEntries(Array.from({ length: shards }, (_, i) => [`s${i}`, 1]));
  return Array.from({ length: shards }, (_, s) => Object.fromEntries(Object.entries(totalCounts).map(([k, n]) => [k, allocCounts(n, weights)[`s${s}`] ?? 0])));
}

/** smooth weighted round robin: total번 안에 각 종류를 정확히 counts만큼 고른다 */
function schedulerOf(counts) {
  const kinds = Object.keys(counts).filter((k) => counts[k] > 0);
  const total = kinds.reduce((a, k) => a + counts[k], 0);
  const current = Object.fromEntries(kinds.map((k) => [k, 0]));
  let sent = 0;
  return () => {
    if (sent >= total) return null;
    let best = kinds[0];
    for (const k of kinds) {
      current[k] += counts[k];
      if (current[k] > current[best]) best = k;
    }
    current[best] -= total;
    sent += 1;
    return best;
  };
}

function writeManifest(out, manifest) {
  mkdirSync(out, { recursive: true });
  const tmp = join(out, 'manifest.json.tmp');
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  renameSync(tmp, join(out, 'manifest.json'));
}

async function main(argv) {
  const o = parseArgs(argv);
  if (o.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const durationMs = Math.round(o.duration * 1000);
  const plan = o.hot
    ? buildHotPlan({ hotRate: o.hotRate, durationMs, partitions: o.partitions, backgroundEvents: o.backgroundEvents })
    : buildPlan({ rate: o.rate, durationMs, partitions: o.partitions });
  const allShards = shardCounts(plan.byRecord, o.shards);
  const myCounts = allShards[o.shard];
  const offsets = Object.fromEntries(Object.keys(plan.byRecord).map((k) => [k, allShards.slice(0, o.shard).reduce((a, s) => a + (s[k] ?? 0), 0)]));
  const startAt = Number.isFinite(o.startAt) ? o.startAt : Date.now() + 1_000;
  const runId = o.runId ?? `${Date.now()}`;
  const hotEventId = o.eventId ?? randomUUID();
  const backgroundEventIds = o.backgroundEventIds ?? Array.from({ length: o.backgroundEvents }, () => randomUUID());
  const ctx = contextOf({ partitions: o.partitions, partitionMode: o.partitionMode, hot: o.hot, hotEventId, backgroundEventIds });
  ctx.backgroundEvents = o.backgroundEvents;

  const manifest = {
    runId,
    shard: o.shard,
    shards: o.shards,
    mode: o.hot ? 'hot' : 'normal',
    rate: o.hot ? null : o.rate,
    hotRate: o.hot ? o.hotRate : null,
    durationMs,
    startedAt: null,
    endedAt: null,
    startAt,
    partitions: o.partitions,
    partitionMode: o.partitionMode,
    eventId: hotEventId,
    backgroundEventIds,
    byRecord: Object.fromEntries(Object.keys(plan.byRecord).map((k) => [k, 0])),
    sums: { orderAmount: 0, paymentAmount: 0 },
    results: { hold: {}, verdict: {} },
    expectedByShard: myCounts,
    sent: 0,
    producerFailures: 0,
    errors: [],
    status: 'running',
  };

  let encoder;
  let platform;
  let producer;
  const controllers = [];
  const stopping = { value: false };
  process.on('SIGTERM', () => { stopping.value = true; });
  process.on('SIGINT', () => { stopping.value = true; });

  try {
    [encoder, platform] = await Promise.all([createEncoder(), loadPlatform()]);
    producer = platform.createKafkaProducer({
      brokers: o.brokers,
      clientId: `f048-producer-${o.shard}-${runId}`,
      kind: 'default',
      extra: {
        'linger.ms': 5,
        'compression.type': 'lz4',
        'batch.num.messages': 10_000,
        'queue.buffering.max.messages': 500_000,
      },
    });
    await producer.connect();
    const indexes = Object.fromEntries(Object.keys(plan.byRecord).map((k) => [k, offsets[k] ?? 0]));
    const next = schedulerOf(myCounts);
    const total = Object.values(myCounts).reduce((a, b) => a + b, 0);
    let sent = 0;
    manifest.startedAt = new Date().toISOString();

    const sendBatch = async (batch) => {
      const byTopic = new Map();
      for (const m of batch) {
        const list = byTopic.get(m.topic) ?? [];
        list.push({ key: m.key, value: m.value, partition: m.partition });
        byTopic.set(m.topic, list);
      }
      let lastErr;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await Promise.all([...byTopic].map(([topic, messages]) => producer.send({ topic, messages })));
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          await sleep(200 * attempt);
        }
      }
      if (lastErr) {
        manifest.producerFailures += batch.length;
        manifest.errors.push({ at: new Date().toISOString(), message: String(lastErr?.message ?? lastErr).slice(0, 500), count: batch.length });
        throw lastErr;
      }
      for (const m of batch) {
        manifest.byRecord[m.kind] += 1;
        manifest.sent += 1;
        if (m.kind === 'order') manifest.sums.orderAmount += m.amount;
        if (m.kind === 'payment') manifest.sums.paymentAmount += m.amount;
        if (m.resultKind === 'hold') manifest.results.hold[m.result] = (manifest.results.hold[m.result] ?? 0) + 1;
        if (m.resultKind === 'verdict') manifest.results.verdict[m.result] = (manifest.results.verdict[m.result] ?? 0) + 1;
      }
      sent += batch.length;
    };

    const wait = startAt - Date.now();
    if (wait > 0) await sleep(wait);
    let lastLog = Date.now();
    while (sent < total && !stopping.value) {
      const elapsed = Math.max(0, Date.now() - startAt);
      const target = Math.min(total, Math.floor((total * elapsed) / durationMs));
      const n = Math.min(500, target - sent);
      if (n <= 0) {
        await sleep(5);
        continue;
      }
      const batch = [];
      for (let j = 0; j < n; j++) {
        const kind = next();
        if (!kind) break;
        const index = indexes[kind]++;
        const at = Date.now();
        const value = eventOf(kind, index, ctx, at);
        const { topic, value: bytes } = encoder.encode(kind, value);
        batch.push({
          topic,
          key: value.eventId,
          value: bytes,
          partition: partitionOf(ctx, kind, index),
          kind,
          amount: sumOf(kind, value),
          result: resultOf(kind, value),
          resultKind: kind === 'hold' ? 'hold' : kind === 'verdict' ? 'verdict' : null,
        });
      }
      if (batch.length) await sendBatch(batch);
      if (Date.now() - lastLog >= 5_000) {
        lastLog = Date.now();
        process.stderr.write(`[f048-producer ${o.shard}] ${sent}/${total}건 (${((sent / Math.max(1, (Date.now() - startAt) / 1000))).toFixed(0)}/s) 실패 ${manifest.producerFailures}\n`);
      }
    }
    // 타이머가 모자라 남은 계획을 마저 보낸다(도착률보다 조금 늦게 끝날 수 있다)
    while (sent < total && !stopping.value) {
      const batch = [];
      for (let j = 0; j < Math.min(500, total - sent); j++) {
        const kind = next();
        if (!kind) break;
        const index = indexes[kind]++;
        const value = eventOf(kind, index, ctx, Date.now());
        const { topic, value: bytes } = encoder.encode(kind, value);
        batch.push({ topic, key: value.eventId, value: bytes, partition: partitionOf(ctx, kind, index), kind, amount: sumOf(kind, value), result: resultOf(kind, value), resultKind: kind === 'hold' ? 'hold' : kind === 'verdict' ? 'verdict' : null });
      }
      if (batch.length) await sendBatch(batch);
    }
    manifest.status = manifest.producerFailures === 0 && sent === total ? 'done' : 'failed';
    manifest.endedAt = new Date().toISOString();
    manifest.stopRequested = stopping.value;
    writeManifest(o.out, manifest);
    process.stderr.write(`[f048-producer ${o.shard}] 끝: ${sent}/${total}건, 실패 ${manifest.producerFailures}\n`);
    return manifest.status === 'done' ? 0 : 1;
  } catch (err) {
    manifest.status = 'failed';
    manifest.error = String(err?.message ?? err).slice(0, 800);
    manifest.endedAt = new Date().toISOString();
    try {
      writeManifest(o.out, manifest);
    } catch {
      // manifest도 못 쓰면 아래 stderr가 유일한 단서다
    }
    process.stderr.write(`[f048-producer ${o.shard}] 실패: ${manifest.error}\n`);
    return 1;
  } finally {
    for (const c of controllers) c();
    await producer?.disconnect().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((err) => {
    process.stderr.write(`발생기 시작 실패: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}

export { main, parseArgs, shardCounts, schedulerOf };
