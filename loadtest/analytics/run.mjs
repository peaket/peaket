// F-04-8 측정 실행기(docs/review/plans/F-04-8.md §5·§6). 컨테이너·표 이전·작업자·발생기·강제 종료·따라잡기·집계를 한 번에 돌린다.
// 사용: node loadtest/analytics/run.mjs smoke | run | crash | hot | ladder | verify | cleanup
// Docker 잠금은 부르는 쪽이 잡는다(bash D:/ticketpass-locks/lock.sh take docker-all lane6-F-04-8).
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { cpus, freemem, platform, release, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CH_PASSWORD, CH_USER, cleanupContainers, clickhouseClient, errText, freePort, sleep, startClickHouse, startKafka, waitFor } from './docker.mjs';
import { allocCounts, judgeAccuracy, listOf, ms, percentile } from './lib.mjs';
import { loadPlatform, loadContracts } from './modules.mjs';
import { WORKER_TOPICS } from './records.mjs';
import { GROUPS, expectedAccuracy, groupLag, kafkaOffsets, mergeManifests, readAccuracy, verifyRun, writeReport } from './verify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const NODE = process.execPath;
const VERSION = 'f048-1';

const USAGE = `사용:
  node loadtest/analytics/run.mjs smoke [--keep]
  node loadtest/analytics/run.mjs run --rate 30000 --duration 1800 [--partitions 12] [--shards 4] [--workers 2] [--out .cache/f048/<이름>]
  node loadtest/analytics/run.mjs crash --rate 30000 --duration 600 --kill analytics,rt --kill-at 120
  node loadtest/analytics/run.mjs hot --hot-rate 4500 --duration 1800 --background-events 11
  node loadtest/analytics/run.mjs ladder --rates 30000,40000,50000,60000,75000,100000 --duration 300
  node loadtest/analytics/run.mjs verify --out .cache/f048/<이름>
  node loadtest/analytics/run.mjs cleanup
공통: --keep(끝나도 컨테이너를 남긴다), --min-freshness-samples 5, --partition-mode hash|spread, --no-kill
`;

function parseArgs(argv) {
  const o = { mode: argv[0] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a}에 값이 없다`); return v; };
    switch (a) {
      case '--rate': o.rate = Number(val()); break;
      case '--hot-rate': o.hotRate = Number(val()); break;
      case '--duration': o.duration = Number(val()); break;
      case '--partitions': o.partitions = Number(val()); break;
      case '--shards': o.shards = Number(val()); break;
      case '--workers': o.workers = Number(val()); break;
      case '--background-events': o.backgroundEvents = Number(val()); break;
      case '--kill': o.kill = val(); break;
      case '--kill-at': o.killAt = Number(val()); break;
      case '--no-kill': o.noKill = true; break;
      case '--partition-mode': o.partitionMode = val(); break;
      case '--out': o.out = val(); break;
      case '--rates': o.rates = val(); break;
      case '--keep': o.keep = true; break;
      case '--min-freshness-samples': o.minFreshnessSamples = Number(val()); break;
      case '--help': case '-h': o.help = true; break;
      default: throw new Error(`모르는 인자: ${a}`);
    }
  }
  return o;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const commitOf = () => {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};

function spawnLogged(spec) {
  const fd = openSync(spec.log, 'a');
  const proc = spawn(NODE, spec.args, { cwd: REPO, env: spec.env, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  return proc;
}

function waitExit(proc, timeoutMs = 30_000) {
  if (proc.exitCode !== null) return Promise.resolve({ code: proc.exitCode, signal: proc.signalCode });
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* 이미 없다 */ }
    }, timeoutMs);
    proc.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
  });
}

async function waitReady(port, timeoutMs = 60_000) {
  await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  }, `작업자 /ready(:${port})`, timeoutMs);
}

/** 계약의 고정 ID를 스키마로 돌려주는 작은 레지스트리. ops-rt가 시작할 때만 쓴다. */
async function startFakeRegistry() {
  const { avroSchemas, localSchemaIds } = await loadContracts();
  const byId = new Map();
  for (const [subject, id] of Object.entries(localSchemaIds)) {
    const full = Object.keys(avroSchemas).find((name) => subject.endsWith(`-${name}`));
    if (full) byId.set(id, avroSchemas[full]);
  }
  const server = createServer((req, res) => {
    const m = /^\/schemas\/ids\/(\d+)/.exec(req.url ?? '');
    const schema = m ? byId.get(Number(m[1])) : undefined;
    if (!schema) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error_code: 40401, message: 'schema not found' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/vnd.schemaregistry.v1+json' });
    res.end(JSON.stringify({ schema: JSON.stringify(schema), schemaType: 'AVRO' }));
  });
  const port = await freePort();
  await new Promise((r, j) => server.listen(port, '127.0.0.1', r).once('error', j));
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

function workerEnv(base, role, index, port) {
  return {
    ...base,
    PEAKET_POD: `f048-${role}-${index}`,
    PEAKET_ADMIN_PORT: String(port),
  };
}

/** `services/<서비스>/dist/main.js` */
const distMain = (svc) => join(REPO, 'services', svc, 'dist', 'main.js');

async function runOne(o) {
  const startedAt = new Date().toISOString();
  const runId = o.runId ?? `${stamp()}-${o.mode}`;
  const out = resolve(o.out ?? join(REPO, '.cache', 'f048', runId));
  mkdirSync(out, { recursive: true });
  mkdirSync(join(out, 'workers'), { recursive: true });
  const config = {
    mode: o.mode,
    rate: o.rate ?? null,
    hotRate: o.hotRate ?? null,
    duration: o.duration,
    partitions: o.partitions,
    shards: o.shards,
    workers: o.workers,
    kill: o.noKill ? [] : listOf(o.kill),
    killAt: o.noKill ? null : o.killAt,
    partitionMode: o.partitionMode,
    backgroundEvents: o.backgroundEvents ?? null,
  };
  const runPath = join(out, 'run.json');
  const run = { runId, version: VERSION, commit: commitOf(), startedAt, out, config, status: 'starting', env: 'ci', groups: { analytics: GROUPS.analytics('ci'), rt: GROUPS.rt('ci') } };
  writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');

  let kafka;
  let ch;
  let registry;
  let admin;
  let sampler;
  const children = [];
  const producerProcs = [];
  const specs = [];
  let localStopping = false;

  const stopWorkers = async () => {
    localStopping = true;
    for (const p of producerProcs) {
      try { p.kill('SIGTERM'); } catch { /* 이미 없다 */ }
    }
    for (const c of children) {
      try { c.proc.kill('SIGTERM'); } catch { /* 이미 없다 */ }
    }
    await Promise.all([...producerProcs, ...children.map((c) => c.proc)].map((p) => waitExit(p, 15_000)));
    producerProcs.length = 0;
    children.length = 0;
  };

  try {
    [kafka, ch] = await Promise.all([startKafka({ runId }), startClickHouse({ runId })]);
    run.brokers = kafka.brokers;
    run.clickhouse = ch.url;
    writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');

    const platform = await loadPlatform();
    admin = platform.createKafkaAdmin({ brokers: kafka.brokers, clientId: `f048-run-${runId}` });
    await waitFor(async () => {
      await admin.connect();
      await admin.listTopics();
      return true;
    }, 'Kafka 기동', 120_000);
    await admin.createTopics({ topics: WORKER_TOPICS.map((topic) => ({ topic, numPartitions: o.partitions })) });
    await waitFor(async () => (await admin.listTopics()).length >= WORKER_TOPICS.length, '토픽 생성', 30_000);

    registry = await startFakeRegistry();
    const key = Buffer.alloc(32, 7).toString('base64');
    const baseEnv = {
      ...process.env,
      PEAKET_ENV: 'ci',
      PEAKET_VERSION: VERSION,
      PEAKET_KAFKA_BROKERS: kafka.brokers.join(','),
      PEAKET_TELEMETRY_KAFKA_BROKERS: kafka.brokers.join(','),
      PEAKET_SCHEMA_REGISTRY_URL: registry.url,
      PEAKET_ANALYTICS_CLICKHOUSE_URL: ch.url,
      PEAKET_ANALYTICS_CLICKHOUSE_USER: CH_USER,
      PEAKET_ANALYTICS_CLICKHOUSE_PASSWORD: CH_PASSWORD,
      PEAKET_ANALYTICS_CLICKHOUSE_TOPOLOGY: 'single',
      PEAKET_ANALYTICS_PSEUDONYM_KEY: key,
      PEAKET_RT_CLICKHOUSE_URL: ch.url,
      PEAKET_RT_CLICKHOUSE_USER: CH_USER,
      PEAKET_RT_CLICKHOUSE_PASSWORD: CH_PASSWORD,
      PEAKET_RT_CLICKHOUSE_TOPOLOGY: 'single',
      PEAKET_SCHEMA_IDS: JSON.stringify((await loadContracts()).localSchemaIds),
    };

    const migrate = (svc, env) => {
      const r = spawnSync(NODE, [distMain(svc), 'migrate'], { cwd: REPO, env, encoding: 'utf8', timeout: 180_000 });
      if (r.status !== 0) throw new Error(`${svc} 표 이전 실패: ${r.stderr?.split('\n')[0] ?? r.status}`);
    };
    migrate('analytics-ingest', { ...baseEnv, PEAKET_SCHEMA_REGISTRY_URL: '' });
    migrate('ops-rt', baseEnv);

    run.start = await kafkaOffsets(admin, WORKER_TOPICS);
    const durationMs = Math.round(o.duration * 1000);
    const eventId = cryptoRandomUuid();
    const backgroundEventIds = Array.from({ length: o.backgroundEvents ?? 11 }, () => cryptoRandomUuid());
    run.eventId = eventId;
    run.backgroundEventIds = backgroundEventIds;
    run.manifestDirs = [];
    writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');

    const spawnWorker = async (role, index) => {
      const port = await freePort();
      const svc = role === 'analytics' ? 'analytics-ingest' : 'ops-rt';
      const spec = {
        role,
        index,
        port,
        name: `${role}-${index}`,
        log: join(out, 'workers', `${role}-${index}.log`),
        env: workerEnv(baseEnv, role, index, port),
        args: [distMain(svc)],
      };
      const proc = spawnLogged(spec);
      children.push({ ...spec, proc });
      return { spec, proc };
    };

    for (let i = 0; i < o.workers; i++) await spawnWorker('analytics', i);
    for (let i = 0; i < o.workers; i++) await spawnWorker('rt', i);
    const pulsePort = await freePort();
    const pulse = {
      role: 'pulse',
      index: 0,
      port: pulsePort,
      name: 'pulse-0',
      log: join(out, 'workers', 'pulse-0.log'),
      env: { ...baseEnv, PEAKET_POD: 'f048-pulse-0', PEAKET_ADMIN_PORT: String(pulsePort) },
      args: [distMain('rt-pulse')],
    };
    children.push({ ...pulse, proc: spawnLogged(pulse) });

    for (const c of children.filter((x) => x.role !== 'pulse')) await waitReady(c.port);
    await sleep(2_000);
    // 작업자가 준비된 뒤에 시작 시각을 정한다. 준비가 늦으면 시작·강제 종료가 한꺼번에 와서 샘플이 사라진다.
    run.startAt = Date.now() + 6_000;
    const startAt = run.startAt;
    writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');

    // ── 발생기 ──
    const manifestDirs = [];
    const producerSpecs = [];
    for (let s = 0; s < o.shards; s++) {
      const dir = join(out, `shard-${s}`);
      mkdirSync(dir, { recursive: true });
      manifestDirs.push(dir);
      const args = [
        join(HERE, 'produce.mjs'),
        '--brokers', kafka.brokers.join(','),
        '--out', dir,
        '--duration', String(o.duration),
        '--shard', String(s),
        '--shards', String(o.shards),
        '--partitions', String(o.partitions),
        '--partition-mode', o.partitionMode,
        '--event-id', eventId,
        '--background-event-ids', JSON.stringify(backgroundEventIds),
        '--start-at', String(startAt),
        '--run-id', runId,
      ];
      if (o.mode === 'hot') args.push('--hot', '--hot-rate', String(o.hotRate), '--background-events', String(o.backgroundEvents ?? 11));
      else args.push('--rate', String(o.rate));
      producerSpecs.push({
        role: 'producer',
        index: s,
        name: `producer-${s}`,
        log: join(out, 'workers', `producer-${s}.log`),
        env: { ...baseEnv },
        args,
      });
    }
    run.manifestDirs = manifestDirs;

    // ── 샘플러 ──
    let recoveryUntil = 0;
    const phaseOf = (at) => (at < startAt ? 'warmup' : at < recoveryUntil ? 'recovery' : at < startAt + durationMs ? 'steady' : 'drain');
    const samples = [];
    const samplePath = join(out, 'freshness.jsonl');
    sampler = startSampler({ ch, admin, groups: run.groups, start: run.start, eventId, out, samplePath, samples, phaseOf, hotTopics: ['trade.seats', 'trade.orders'], pulseParts: 3 * o.partitions });

    // ── 강제 종료 타이머 ──
    let killTimer;
    const killInfo = { at: null, roles: [], restoredAt: null };
    const roles = run.config.kill ?? [];
    if (roles.length && Number.isFinite(run.config.killAt) && run.config.killAt > 0) {
      const wait = startAt + run.config.killAt * 1000 - Date.now();
      killTimer = setTimeout(async () => {
        if (localStopping) return;
        killInfo.at = new Date().toISOString();
        killInfo.roles = roles;
        recoveryUntil = Date.now() + 60_000;
        const targets = children.filter((c) => roles.includes(c.role));
        for (const c of targets) {
          try { c.proc.kill('SIGKILL'); } catch { /* 이미 없다 */ }
        }
        await Promise.all(targets.map((c) => waitExit(c.proc, 10_000)));
        for (const c of targets) children.splice(children.indexOf(c), 1);
        await sleep(2_000);
        for (const role of roles) {
          for (let i = 0; i < o.workers; i++) await spawnWorker(role, i);
        }
        killInfo.restoredAt = new Date().toISOString();
        process.stderr.write(`[f048] ${roles.join(',')} SIGKILL·재기동 완료 ${killInfo.restoredAt}\n`);
      }, Math.max(0, wait));
    }

    // ── 발생기 실행 ──
    const producers = producerSpecs.map((s) => {
      const proc = spawnLogged(s);
      producerProcs.push(proc);
      return { spec: s, proc };
    });
    const codes = await Promise.all(producers.map((p) => waitExit(p.proc, durationMs + 180_000)));
    clearTimeout(killTimer);
    run.producerExit = codes;
    process.stderr.write(`[f048] 발생기 끝: ${codes.map((c) => c.code).join(',')}\n`);

    // ── 따라잡기 ──
    // 1) 심장 박동이 도는 채로 본 데이터를 따라잡는다.
    const drain = async (end, timeoutMs = 180_000) => {
      let stable = 0;
      let last = null;
      const started = Date.now();
      for (;;) {
        const a = await groupLag(admin, run.groups.analytics, end, run.start);
        const r = await groupLag(admin, run.groups.rt, end, run.start);
        last = { analytics: a, rt: r };
        const total = (a.total ?? Number.POSITIVE_INFINITY) + (r.total ?? Number.POSITIVE_INFINITY);
        if (total === 0) stable += 1;
        else stable = 0;
        if (stable >= 3) break;
        if (Date.now() - started > timeoutMs) break;
        await sleep(2_000);
      }
      return { ms: Date.now() - started, last };
    };
    const firstEnd = await kafkaOffsets(admin, WORKER_TOPICS);
    const firstDrain = await drain(firstEnd);
    run.firstDrainMs = firstDrain.ms;

    // 2) 샘플러를 멈추고 심장 박동을 멈춘다. 심장 박동이 계속되면 brz_offset이 마지막 스냅숏보다 많아져 커버리지가 전체보다 커진다.
    sampler.stop();
    await sampler.done();
    const pulseEntry = children.find((c) => c.role === 'pulse');
    if (pulseEntry) {
      try { pulseEntry.proc.kill('SIGTERM'); } catch { /* 이미 없다 */ }
      await waitExit(pulseEntry.proc, 10_000);
      children.splice(children.indexOf(pulseEntry), 1);
    }
    await sleep(1_000);
    const finalEnd = await kafkaOffsets(admin, WORKER_TOPICS);
    const finalDrain = await drain(finalEnd, 120_000);
    run.drainMs = firstDrain.ms + finalDrain.ms;
    run.end = finalEnd;
    run.kill = killInfo;
    run.producerManifests = producerSpecs.map((s) => join(s.args[s.args.indexOf('--out') + 1], 'manifest.json'));
    writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');

    // 그룹 밀림이 0이어도 재조정 중 파티션 하나가 늦게 붙는 경우가 있다. 표의 고유 수가 기대와 같아질 때까지 한 번 더 기다린다.
    const earlyManifests = run.producerManifests.map((p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null)).filter(Boolean);
    const earlyManifest = mergeManifests(earlyManifests);
    earlyManifest.runId = runId;
    if (earlyManifest.producerOk) {
      const expectAccuracy = expectedAccuracy(earlyManifest);
      await waitFor(async () => judgeAccuracy({ expected: expectAccuracy, actual: await readAccuracy(ch, earlyManifest) }).pass, '브론즈·rt 고유 수 따라잡기', 60_000, 2_000).catch(() => {});
    }

    await stopWorkers();

    const manifests = run.producerManifests.map((p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null)).filter(Boolean);
    const manifest = mergeManifests(manifests);
    manifest.runId = runId;
    const report = await verifyRun({
      ch,
      admin,
      manifest,
      start: run.start,
      end: finalEnd,
      groups: run.groups,
      samples,
      mode: o.mode,
      minFreshnessSamples: o.minFreshnessSamples ?? (o.mode === 'smoke' ? 5 : 10),
    });
    writeReport(out, report);
    writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    writeFileSync(join(out, 'infra.json'), `${JSON.stringify(infraOf(runId, kafka, ch), null, 2)}\n`, 'utf8');
    run.endedAt = new Date().toISOString();
    run.verdict = report.verdict;
    run.status = report.verdict === 'pass' ? 'pass' : report.verdict === 'invalid' ? 'invalid' : 'fail';
    writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
    process.stderr.write(`[f048] ${report.verdict}: ${out}\n`);
    return { out, report, exitCode: report.verdict === 'pass' ? 0 : report.verdict === 'invalid' ? 3 : 1 };
  } catch (err) {
    run.status = 'error';
    run.error = errText(err).slice(0, 1_000);
    run.endedAt = new Date().toISOString();
    try { writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8'); } catch { /* 디스크 문제 */ }
    process.stderr.write(`[f048] 실행 실패: ${run.error}\n`);
    return { out, report: null, exitCode: 3 };
  } finally {
    sampler?.stop();
    await sampler?.done?.().catch(() => {});
    await stopWorkers().catch(() => {});
    await admin?.disconnect().catch(() => {});
    await registry?.close().catch(() => {});
    if (!o.keep) {
      kafka?.stop();
      ch?.stop();
    }
  }
}

function cryptoRandomUuid() {
  return randomUUID();
}

function infraOf(runId, kafka, ch) {
  return {
    runId,
    capturedAt: new Date().toISOString(),
    platform: platform(),
    release: release(),
    cpu: cpus()[0]?.model ?? null,
    cores: cpus().length,
    memoryGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    freeGiB: Math.round((freemem() / 1024 ** 3) * 10) / 10,
    docker: (() => {
      const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
      return r.status === 0 ? r.stdout.trim() : null;
    })(),
    kafka: { image: 'apache/kafka:3.9.2', brokers: kafka?.brokers ?? null },
    clickhouse: { image: 'clickhouse/clickhouse-server:24.12', url: ch?.url ?? null, user: CH_USER },
  };
}

/** 1초마다 신선도·조회 시간·소비 밀림·CPU를 남긴다 */
function startSampler({ ch, admin, groups, start, eventId, out, samplePath, samples, phaseOf, hotTopics, pulseParts }) {
  let stopped = false;
  let busy = false;
  let prevCpu = cpus().map((c) => c.times);
  let tick = 0;
  const hostCpu = () => {
    const now = cpus().map((c) => c.times);
    let idle = 0;
    let total = 0;
    for (let i = 0; i < now.length; i++) {
      const a = prevCpu[i];
      const b = now[i];
      const didle = b.idle - a.idle;
      const dt = (b.user - a.user) + (b.nice - a.nice) + (b.sys - a.sys) + (b.irq - a.irq) + didle;
      idle += didle;
      total += dt;
    }
    prevCpu = now;
    return total > 0 ? 100 * (1 - idle / total) : null;
  };
  const write = (s) => {
    samples.push(s);
    writeFileSync(samplePath, `${JSON.stringify(s)}\n`, { flag: 'a' });
  };
  const run = async () => {
    if (busy || stopped) return;
    busy = true;
    const at = Date.now();
    const phase = phaseOf(at);
    const sample = { at, phase, label: new Date(at).toISOString(), rtMs: null, bronzeMs: null, queryMs: null, hotLag: null, lag: null, hostCpu: hostCpu(), chCpu: null, error: null };
    try {
      const rt = await ch.rows(`SELECT count() AS parts, if(count() = 0, NULL, toInt64(toUnixTimestamp64Milli(now64(3)) - toUnixTimestamp64Milli(min(last)))) AS ms FROM (SELECT topic, kafka_partition, max(produced_at) AS last FROM rt.pulse WHERE produced_at >= now64(3) - INTERVAL 1 HOUR GROUP BY topic, kafka_partition)`);
      sample.pulseParts = Number(rt[0]?.parts ?? 0);
      sample.expectedPulseParts = pulseParts;
      sample.rtMs = sample.pulseParts >= pulseParts && rt[0]?.ms !== null && rt[0]?.ms !== undefined ? Number(rt[0].ms) : null;
      if (sample.pulseParts < pulseParts) sample.error = `심장 박동 파티션 ${sample.pulseParts}/${pulseParts}`;
      const bronze = await ch.rows(`SELECT if(count() = 0, NULL, toInt64(toUnixTimestamp64Milli(now64(3)) - toUnixTimestamp64Milli(max(kafka_ts)))) AS ms FROM bronze.brz_order_event`);
      sample.bronzeMs = bronze[0]?.ms === null || bronze[0]?.ms === undefined ? null : Number(bronze[0].ms);
      const q0 = performance.now();
      await ch.query(`SELECT count() FROM rt.sale_event WHERE event_id = {eventId:String}`, { eventId });
      const q1 = performance.now();
      await ch.query('SELECT count() FROM rt.v_freshness');
      const q2 = performance.now();
      sample.queryMs = Math.max(q1 - q0, q2 - q1);
      if (tick % 2 === 0) {
        const end = await kafkaOffsets(admin, WORKER_TOPICS);
        const a = await groupLag(admin, groups.analytics, end, start);
        const r = await groupLag(admin, groups.rt, end, start);
        sample.lag = { analytics: { total: a.total, max: a.max }, rt: { total: r.total, max: r.max } };
        const hot = [...(a.partitions ?? []), ...(r.partitions ?? [])].filter((p) => hotTopics.includes(p.topic) && p.partition === 0);
        sample.hotLag = hot.length ? Math.max(...hot.map((p) => p.lag)) : 0;
      }
      if (tick % 3 === 0) {
        // Docker 통계는 느리므로 3초에 한 번만 읽는다
        const stats = await ch.stats();
        sample.chCpu = stats?.cpuPct ?? null;
      }
    } catch (err) {
      sample.error = errText(err).slice(0, 300);
    }
    tick += 1;
    write(sample);
    busy = false;
  };
  const timer = setInterval(() => { void run(); }, 1_000);
  timer.unref?.();
  return {
    stop() { stopped = true; clearInterval(timer); },
    done: async () => {
      while (busy) await sleep(100);
    },
  };
}

// WORKER_TOPICS를 샘플러가 쓰므로 import한다(위에서 이미 가져왔다)
void WORKER_TOPICS;

async function main(argv) {
  const o = parseArgs(argv);
  if (o.help || o.mode === '--help' || o.mode === '-h' || !o.mode) {
    process.stdout.write(USAGE);
    return o.help || o.mode === '--help' || o.mode === '-h' ? 0 : 2;
  }
  if (o.mode === 'cleanup') {
    const n = cleanupContainers();
    process.stdout.write(`F-04-8 컨테이너 ${n}개를 지웠다\n`);
    return 0;
  }
  if (o.mode === 'verify') {
    if (!o.out) throw new Error('verify에는 --out이 필요하다');
    const run = JSON.parse(readFileSync(join(resolve(o.out), 'run.json'), 'utf8'));
    const platform = await loadPlatform();
    const admin = platform.createKafkaAdmin({ brokers: run.brokers, clientId: `f048-verify-${Date.now()}` });
    await admin.connect();
    try {
      const manifests = (run.producerManifests ?? []).map((p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null)).filter(Boolean);
      const manifest = mergeManifests(manifests);
      manifest.runId = run.runId;
      const end = await kafkaOffsets(admin, Object.keys(run.start ?? {}));
      const samples = existsSync(join(resolve(o.out), 'freshness.jsonl')) ? readFileSync(join(resolve(o.out), 'freshness.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
      const ch = clickhouseClient(run.clickhouse);
      const report = await verifyRun({ ch, admin, manifest, start: run.start ?? {}, end, groups: run.groups, samples, mode: run.config?.mode, minFreshnessSamples: o.minFreshnessSamples ?? 5 });
      writeReport(resolve(o.out), report);
      process.stdout.write(`${report.verdict}: ${o.out}\n`);
      return report.verdict === 'pass' ? 0 : report.verdict === 'invalid' ? 3 : 1;
    } finally {
      await admin.disconnect().catch(() => {});
    }
  }
  if (o.mode === 'smoke') {
    return (await runOne({ ...o, mode: 'smoke', rate: 2_000, duration: 30, killAt: 10, kill: 'analytics,rt', partitions: 6, shards: 1, workers: 1, partitionMode: o.partitionMode ?? 'hash' })).exitCode;
  }
  if (o.mode === 'run' || o.mode === 'crash' || o.mode === 'hot') {
    const defaults = o.mode === 'crash'
      ? { rate: 30_000, duration: 600, killAt: 120, kill: 'analytics,rt' }
      : o.mode === 'hot'
        ? { hotRate: 4_500, duration: 1_800, backgroundEvents: 11, killAt: null, kill: '' }
        : { duration: 1_800, killAt: null, kill: '' };
    const cfg = {
      ...defaults,
      ...o,
      mode: o.mode,
      rate: o.rate ?? defaults.rate,
      hotRate: o.hotRate ?? defaults.hotRate,
      duration: o.duration ?? defaults.duration,
      partitions: o.partitions ?? 12,
      shards: o.shards ?? (o.mode === 'hot' ? 2 : 4),
      workers: o.workers ?? 2,
      backgroundEvents: o.backgroundEvents ?? defaults.backgroundEvents,
      partitionMode: o.partitionMode ?? 'hash',
      noKill: o.noKill || !defaults.kill,
    };
    if (!Number.isFinite(cfg.rate ?? cfg.hotRate) || (cfg.rate ?? 0) <= 0 && o.mode !== 'hot') { process.stderr.write('--rate가 필요하다\n'); return 2; }
    return (await runOne(cfg)).exitCode;
  }
  if (o.mode === 'ladder') {
    const rates = String(o.rates ?? '30000,40000,50000,60000,75000,100000').split(',').map(Number);
    const base = resolve(o.out ?? join(REPO, '.cache', 'f048', `${stamp()}-ladder`));
    mkdirSync(base, { recursive: true });
    const results = [];
    for (const rate of rates) {
      const r = await runOne({ ...o, mode: 'run', rate, duration: o.duration ?? 300, partitions: o.partitions ?? 12, shards: o.shards ?? 4, workers: o.workers ?? 2, killAt: null, kill: '', noKill: true, out: join(base, `rate-${rate}`), runId: `${stamp()}-ladder-${rate}` });
      results.push({ rate, verdict: r.report?.verdict ?? 'invalid', out: r.out, freshnessP95: r.report?.freshness?.rt?.p95 ?? null, loss: r.report?.loss?.ratio ?? null, chCpu: r.report?.cpu?.clickhouseP95 ?? null });
      writeFileSync(join(base, 'ladder.json'), `${JSON.stringify({ rates, results }, null, 2)}\n`, 'utf8');
      if (results.at(-1).verdict !== 'pass') break;
    }
    const bad = results.find((r) => r.verdict !== 'pass');
    return bad ? (bad.verdict === 'invalid' ? 3 : 1) : 0;
  }
  process.stderr.write(`모르는 명령: ${o.mode}\n${USAGE}`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 2;
  });
}

export { main, parseArgs, runOne, startSampler };
