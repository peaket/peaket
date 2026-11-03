#!/usr/bin/env node
// wbs 0.5.1 PoC 측정을 차례로 돈다(loadtest/poc/README.md). 측정마다 결과 JSON과 장부 수집 인자를 .cache/peaket-poc/out/에 남기고,
// 끝나면 record.mjs가 성능 장부(docs/perf-ledger/runs/)로 옮긴다. 실패한 측정은 기록하고 다음으로 넘어간다.
// 규칙(docs/perf-ledger.md §3, docs/verification.md §3.5): 오픈 모델, 예열 제외, Redis는 TLS 켬 3회·끔 1회(판정은 켬), 호스트 지표.
// 쓰는 법: node loadtest/poc/run.mjs [묶음 이름...]   묶음: incr clients behaviors vt41 kafka seat number numberbatch (기본: number·numberbatch 빼고 모두, 이 순서)
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { IMAGES, NET, bench, build, ensureNet, kafkaDown, kafkaUp, nodesArg, valkeyDown, valkeyUp } from './stack.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, '.cache', 'peaket-poc', 'out');
const PLAN = join(OUT, 'plan.jsonl');
const DAY = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // KST 날짜
const N = nodesArg();
mkdirSync(OUT, { recursive: true });
const log = (m) => {
  const line = `${new Date().toISOString()} ${m}`;
  console.log(line);
  appendFileSync(join(OUT, 'run.log'), line + '\n');
};
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryDocker = (...args) => {
  try {
    return docker(...args);
  } catch {
    return null;
  }
};

/** 진입 ② 묶음 Lua 원문을 queue-svc에서 가져와 측정 이미지의 lua/에 쓴다. 운영 원문과 같게 하려고 사본은 커밋하지 않는다(.gitignore) */
async function syncEntryLua() {
  const m = await import(pathToFileURL(join(ROOT, 'services', 'queue-svc', 'src', 'modules', 'entry', 'adapters', 'entry-lua.ts')).href);
  const head = '-- 생성물: services/queue-svc/src/modules/entry/adapters/entry-lua.ts의 NUMBER_BATCH_LUA. loadtest/poc/run.mjs가 측정 전에 쓴다(고치지 않는다)\n';
  writeFileSync(join(ROOT, 'loadtest', 'poc', 'bench', 'lua', 'entry-number-batch.lua'), head + m.NUMBER_BATCH_LUA);
}

/** 측정 하나를 돌리고 장부 수집 인자를 남긴다 */
function record(entry) {
  appendFileSync(PLAN, JSON.stringify(entry) + '\n');
}
function runBench(id, { cpus, withDocker = false, args, ledger }) {
  const startedAt = new Date().toISOString();
  try {
    bench(id, { cpus, withDocker, args });
    record({ id, startedAt, endedAt: new Date().toISOString(), cpus, args, ...ledger });
    log(`끝 ${id}`);
  } catch (err) {
    log(`실패 ${id}: ${String(err.message).slice(0, 500)}`);
  }
}

// ---- 묶음 ----
const groups = {
  // NFR-001: 샤드 하나에 직접 INCR vs 파드별 INCRBY 마이크로 배치(2ms [가정]), 20만/s, 진입 서버 4대 흉내
  async incr() {
    for (const tls of [true, false]) {
      await valkeyUp({ tls });
      for (const op of ['incr', 'batch']) {
        for (let r = 1; r <= (tls ? 3 : 1); r += 1) {
          const id = `${DAY}-incr-${op}-${tls ? 'tls' : 'notls'}-r${r}`;
          runBench(id, {
            cpus: '6',
            args: ['src/rate.mjs', '--nodes', N, '--tls', String(tls), '--client', 'node-redis', '--op', op, '--rate', '200000', '--procs', '4', '--duration', '60', '--warmup', '15', '--batch-ms', '2'],
            ledger: { kpi: 'NFR-001', rps: 200000, duration: 60, warmup: 15, scenario: 'loadtest/poc/bench/src/rate.mjs', scenarioArgs: `--op ${op} --rate 200000 --procs 4`, redisTls: tls, pairOf: `${DAY}-incr-${op}-${tls ? 'notls' : 'tls'}-r1`, notes: `한 키 INCR(${op === 'incr' ? '직접' : '파드별 INCRBY 2ms 묶음'}), node-redis 6.3.0, 진입 서버 4대를 프로세스 4개로 흉내(컨테이너 CPU 6)` },
          });
        }
      }
    }
  },
  // NFR-001 다시 재기(BUILD_ORDER PRF-060이 넘긴 것): 한 키에 진입 ② Lua(queue-svc NUMBER)를 20만/s. 로비·묶음 표시가 선 뒤의 평시 경로
  // (서버 시각 → 세대 → 표시 확인 둘 → INCR → 수명 늘리기)라 INCR 하나보다 엔진 일이 많다
  async number() {
    for (const tls of [true, false]) {
      await valkeyUp({ tls });
      for (let r = 1; r <= (tls ? 3 : 1); r += 1) {
        // 2026-11-03 PRF-070의 `number-*`는 옛 단건 Lua(NUMBER)였다. 같은 날 다시 재도 이름이 겹치지 않게 n1을 붙인다
        const id = `${DAY}-number-n1-${tls ? 'tls' : 'notls'}-r${r}`;
        runBench(id, {
          cpus: '6',
          args: ['src/rate.mjs', '--nodes', N, '--tls', String(tls), '--client', 'node-redis', '--op', 'number', '--rate', '200000', '--procs', '4', '--duration', '60', '--warmup', '15'],
          ledger: { kpi: 'NFR-001', rps: 200000, duration: 60, warmup: 15, scenario: 'loadtest/poc/bench/src/rate.mjs', scenarioArgs: '--op number --rate 200000 --procs 4', redisTls: tls, pairOf: `${DAY}-number-n1-${tls ? 'notls' : 'tls'}-r1`, notes: '한 키 진입 ② 묶음 Lua(queue-svc NUMBER_BATCH: 서버 시각·세대·로비와 묶음 표시 확인·INCRBY·수명 늘리기)를 요청마다 1건으로(묶음 없는 직접 호출, 표시가 선 뒤의 평시 경로), node-redis 6.3.0, 진입 서버 4대를 프로세스 4개로 흉내(컨테이너 CPU 6)' },
        });
      }
    }
  },
  // Q-T5 배치 모드(ADR-0179): 파드처럼 진입 서버마다 2ms씩 모아 묶음 Lua 한 번. 직접 호출(number)과 같은 조건으로 잰다
  async numberbatch() {
    for (const tls of [true, false]) {
      await valkeyUp({ tls });
      for (let r = 1; r <= (tls ? 3 : 1); r += 1) {
        const id = `${DAY}-numberbatch-${tls ? 'tls' : 'notls'}-r${r}`;
        runBench(id, {
          cpus: '6',
          // PRF-085 ③: 같은 실행에서 키 주인 주 노드의 복제 지연을 WAIT 탐침(10ms마다)으로 함께 잰다(ADR-0181 복제 지연 p99.9 [가정] 0.3초)
          args: ['src/rate.mjs', '--nodes', N, '--tls', String(tls), '--client', 'node-redis', '--op', 'number-batch', '--rate', '200000', '--procs', '4', '--duration', '60', '--warmup', '15', '--batch-ms', '2', '--wait-probe-ms', '10'],
          ledger: { kpi: 'NFR-001', rps: 200000, duration: 60, warmup: 15, scenario: 'loadtest/poc/bench/src/rate.mjs', scenarioArgs: '--op number-batch --rate 200000 --procs 4 --batch-ms 2 --wait-probe-ms 10', redisTls: tls, pairOf: `${DAY}-numberbatch-${tls ? 'notls' : 'tls'}-r1`, notes: '한 키 진입 ② 묶음 Lua(queue-svc NUMBER_BATCH, 진입 서버마다 2ms 묶음, Q-T5 배치 모드, ADR-0179), node-redis 6.3.0, 진입 서버 4대를 프로세스 4개로 흉내(컨테이너 CPU 6). 같은 실행에서 키 주인 주 노드에 10ms마다 같은 슬롯 SET + WAIT 1 1000으로 복제 지연의 위쪽 값을 잼(bench-summary.json wait_probe, PRF-085 ③)' },
        });
      }
    }
  },
  // 진입 용량 식의 상한 R(Redis 한 키 최대 처리량, docs/verification.md §3.3): 진입 서버 여섯(프로세스 여섯, 동시 512씩)이 한 키에 닫힌 모델로
  // 보낸다. 엔진 스레드가 다 차기 전에 발생기가 먼저 찰 수 있어 엔진 CPU를 함께 남긴다
  async incrmax() {
    for (const tls of [true, false]) {
      await valkeyUp({ tls });
      for (let r = 1; r <= (tls ? 3 : 1); r += 1) {
        const t = tls ? 'tls' : 'notls';
        runBench(`${DAY}-incrmax-${t}-r${r}`, {
          cpus: '10',
          args: ['src/rate.mjs', '--nodes', N, '--tls', String(tls), '--client', 'node-redis', '--op', 'incr', '--model', 'closed', '--conc', '512', '--procs', '6', '--duration', '20', '--warmup', '5'],
          ledger: { kpi: 'NFR-001', duration: 20, warmup: 5, closed: true, scenario: 'loadtest/poc/bench/src/rate.mjs', scenarioArgs: '--op incr --model closed --conc 512 --procs 6', redisTls: tls, pairOf: `${DAY}-incrmax-${tls ? 'notls' : 'tls'}-r1`, notes: '한 키 INCR 최대 처리량 R(닫힌 모델, 진입 서버 여섯을 프로세스 여섯으로, 컨테이너 CPU 10, 코어 혼합: 주 노드 6 + 복제 3 + 발생기 10 > 16)' },
        });
      }
    }
    valkeyDown();
  },
  // V-T33 ①: 클라이언트 셋의 자동 파이프라이닝 최대 처리량(닫힌 모델)과 정해진 도착률의 p99(INCR 4만/s, 홀드 Lua 5천/s), 프로세스 하나·CPU 1
  async clients() {
    for (const tls of [true, false]) {
      await valkeyUp({ tls });
      for (const client of ['node-redis', 'ioredis', 'glide']) {
        for (let r = 1; r <= (tls ? 3 : 1); r += 1) {
          const t = tls ? 'tls' : 'notls';
          const pair = (kind) => `${DAY}-vt33-${kind}-${client}-${tls ? 'notls' : 'tls'}-r1`;
          runBench(`${DAY}-vt33-max-${client}-${t}-r${r}`, {
            cpus: '1',
            args: ['src/rate.mjs', '--nodes', N, '--tls', String(tls), '--client', client, '--op', 'incr', '--model', 'closed', '--conc', '256', '--procs', '1', '--duration', '25', '--warmup', '5'],
            ledger: { kpi: 'V-T33', duration: 25, warmup: 5, closed: true, scenario: 'loadtest/poc/bench/src/rate.mjs', scenarioArgs: `--client ${client} --op incr --model closed --conc 256`, redisTls: tls, pairOf: pair('max'), notes: `V-T33 ① ${client} 자동 파이프라이닝 최대 처리량(닫힌 모델, 동시 256, 지연은 참고값), 프로세스 하나 CPU 1` },
          });
          runBench(`${DAY}-vt33-incr-${client}-${t}-r${r}`, {
            cpus: '1',
            args: ['src/rate.mjs', '--nodes', N, '--tls', String(tls), '--client', client, '--op', 'incr', '--rate', '40000', '--procs', '1', '--duration', '45', '--warmup', '15'],
            ledger: { kpi: 'V-T33', rps: 40000, duration: 45, warmup: 15, scenario: 'loadtest/poc/bench/src/rate.mjs', scenarioArgs: `--client ${client} --op incr --rate 40000`, redisTls: tls, pairOf: pair('incr'), notes: `V-T33 ① ${client} queue-svc 진입 INCR 4만/s(오픈 모델), 프로세스 하나 CPU 1` },
          });
          runBench(`${DAY}-vt33-hold-${client}-${t}-r${r}`, {
            cpus: '1',
            args: ['src/rate.mjs', '--nodes', N, '--tls', String(tls), '--client', client, '--op', 'hold', '--rate', '5000', '--procs', '1', '--duration', '45', '--warmup', '15'],
            ledger: { kpi: 'V-T33', rps: 5000, duration: 45, warmup: 15, scenario: 'loadtest/poc/bench/src/rate.mjs', scenarioArgs: `--client ${client} --op hold --rate 5000`, redisTls: tls, pairOf: pair('hold'), notes: `V-T33 ① ${client} 좌석 홀드 Lua 5천/s(오픈 모델, EVALSHA), 프로세스 하나 CPU 1` },
          });
        }
      }
    }
  },
  // V-T33 ②~⑤: 클라이언트마다 3회(클러스터를 매번 새로 만든다). node-redis-deadline은 호출 쪽 100ms 마감을 건 node-redis
  async behaviors() {
    for (const client of ['node-redis', 'node-redis-deadline', 'ioredis', 'glide']) {
      for (let r = 1; r <= 3; r += 1) {
        await valkeyUp({ tls: true });
        runBench(`${DAY}-vt33-behaviors-${client}-r${r}`, {
          cpus: '2',
          withDocker: true,
          args: ['src/behaviors.mjs', '--nodes', N, '--tls', 'true', '--client', client, '--network', NET],
          ledger: null,
        });
      }
    }
  },
  // V-T41: 세 구성 × 두 경로. 닫힌 모델로 최대 처리량을 잰 뒤, 가장 느린 구성 최대의 60% 도착률로 오픈 모델 3회
  async vt41() {
    valkeyDown();
    kafkaDown();
    ensureNet();
    for (const route of ['hold', 'entry']) {
      const max = {};
      for (const config of ['express-zod', 'fastify-zod', 'fastify-schema']) {
        const r = await vt41Run({ config, route, mode: 'closed', id: `${DAY}-vt41-max-${config}-${route}` });
        if (r) max[config] = r.app.handled / (r.app.wall_us / 1e6);
      }
      const rate = Math.floor((Math.min(...Object.values(max)) * 0.6) / 100) * 100;
      log(`V-T41 ${route} 최대 처리량 ${JSON.stringify(max)} → 오픈 모델 ${rate}/s`);
      for (let rep = 1; rep <= 3; rep += 1) {
        for (const config of ['express-zod', 'fastify-zod', 'fastify-schema']) await vt41Run({ config, route, mode: 'open', rate, id: `${DAY}-vt41-${config}-${route}-r${rep}` });
      }
    }
  },
  // V-T41 오픈 모델 다시 재기: 닫힌 모델 최대(이미 잰 값)의 가장 느린 구성 50%로, 가상 사용자를 넉넉히 미리 만들어 3회씩
  async vt41open() {
    valkeyDown();
    kafkaDown();
    ensureNet();
    for (const route of ['hold', 'entry']) {
      const max = {};
      // 닫힌 모델 최대도 고친 측정 창으로 다시 잰다(같은 ID라 장부에는 마지막 것이 들어간다)
      // 첫 회차(무효로 남긴다)를 덮어쓰지 않게 다른 ID(max2, -b-)로 잰다(perf-ledger §3의 10)
      for (const config of ['express-zod', 'fastify-zod', 'fastify-schema']) await vt41Run({ config, route, mode: 'closed', id: `${DAY}-vt41-max2-${config}-${route}` });
      for (const config of ['express-zod', 'fastify-zod', 'fastify-schema']) {
        const f = join(OUT, `${DAY}-vt41-max2-${config}-${route}.json`);
        if (!existsSync(f)) throw new Error(`닫힌 모델 결과가 없다: ${f}`);
        max[config] = JSON.parse(readFileSync(f, 'utf8')).throughput_per_s;
      }
      const rate = Math.floor((Math.min(...Object.values(max)) * 0.5) / 100) * 100;
      log(`V-T41 ${route} 다시 재기: 최대 처리량 ${JSON.stringify(max)} → 오픈 모델 ${rate}/s`);
      for (let rep = 1; rep <= 3; rep += 1) {
        for (const config of ['express-zod', 'fastify-zod', 'fastify-schema']) await vt41Run({ config, route, mode: 'open', rate, id: `${DAY}-vt41-${config}-${route}-b-r${rep}` });
      }
    }
  },
  // V-T41 세 번째: 두 번째는 가상 사용자 4,009명을 k6 CPU 4개로 돌려 k6가 버거웠다(응답 시간이 음수로 찍히고 연결 대기 1.2초).
  // 미리 만드는 가상 사용자 400명(최대 1,200명), k6 CPU 8개, 도착률은 두 번째와 같다(닫힌 모델 max2의 가장 느린 구성 50%)
  async vt41c() {
    valkeyDown();
    kafkaDown();
    ensureNet();
    for (const route of ['hold', 'entry']) {
      const max = {};
      for (const config of ['express-zod', 'fastify-zod', 'fastify-schema']) {
        const f = join(OUT, `${DAY}-vt41-max2-${config}-${route}.json`);
        if (!existsSync(f)) throw new Error(`닫힌 모델 결과가 없다: ${f}`);
        max[config] = JSON.parse(readFileSync(f, 'utf8')).throughput_per_s;
      }
      const rate = Math.floor((Math.min(...Object.values(max)) * 0.5) / 100) * 100;
      log(`V-T41 ${route} 세 번째: 최대 처리량 ${JSON.stringify(max)} → 오픈 모델 ${rate}/s`);
      for (let rep = 1; rep <= 3; rep += 1) {
        for (const config of ['express-zod', 'fastify-zod', 'fastify-schema']) await vt41Run({ config, route, mode: 'open', rate, id: `${DAY}-vt41-${config}-${route}-c-r${rep}`, k6Cpus: '8', prevus: 400 });
      }
    }
  },
  async kafka() {
    valkeyDown();
    await kafkaUp();
    for (let r = 1; r <= 3; r += 1) {
      runBench(`${DAY}-kafka-mixed-r${r}`, {
        cpus: '4',
        args: ['src/kafka-perf.mjs', '--case', 'mixed', '--duration', '60', '--warmup', '15'],
        ledger: { kpi: 'ST-T18', rps: 5900, duration: 60, warmup: 15, scenario: 'loadtest/poc/bench/src/kafka-perf.mjs', scenarioArgs: '--case mixed --tel-rate 5600 --trade-rate 300', notes: 'Kafka 3.9.2 셋(복제 3, min.insync 2), @confluentinc/kafka-javascript 1.11.0, 텔레메트리 5,600/s + 거래 300/s 함께, p99는 거래 토픽 acks=all 보내기 지연' },
      });
    }
    runBench(`${DAY}-kafka-max`, { cpus: '4', args: ['src/kafka-perf.mjs', '--case', 'max', '--duration', '30', '--warmup', '5'], ledger: { kpi: 'ST-T18', duration: 30, warmup: 5, closed: true, scenario: 'loadtest/poc/bench/src/kafka-perf.mjs', scenarioArgs: '--case max --conc 64', notes: '텔레메트리 생산자 하나의 최대 처리량(묶음 100건, 닫힌 모델)' } });
    runBench(`${DAY}-kafka-batch-keyed`, { cpus: '4', args: ['src/kafka-perf.mjs', '--case', 'batch', '--mode', 'keyed', '--messages', '200000'], ledger: { kpi: 'ST-T18', scenario: 'loadtest/poc/bench/src/kafka-perf.mjs', scenarioArgs: '--case batch --mode keyed --messages 200000 --sizes 32,1,128,-1', closed: true, notes: 'js.consumer.max.batch.size별 eachMessage 소비 처리량(파티션마다 32개까지 함께 처리, 처리기 1ms)' } });
    runBench(`${DAY}-kafka-batch-serial`, { cpus: '4', args: ['src/kafka-perf.mjs', '--case', 'batch', '--mode', 'serial', '--messages', '30000'], ledger: { kpi: 'ST-T18', scenario: 'loadtest/poc/bench/src/kafka-perf.mjs', scenarioArgs: '--case batch --mode serial --messages 30000 --sizes 32,1,128,-1', closed: true, notes: 'js.consumer.max.batch.size별 eachMessage 소비 처리량(사건마다 처리를 기다림, 처리기 1ms)' } });
    runBench(`${DAY}-kafka-admin`, { cpus: '4', args: ['src/kafka-perf.mjs', '--case', 'admin'], ledger: null });
    kafkaDown();
  },
  // S-T27 남은 몫(2026-11-01 11시 다시): 만료 작업 Lua 한 번에 100석. ② 한 샤드 TLS 켬 3회·끔 1회, ② 서로 다른 샤드 1회, ① 켬·끔 1회씩.
  // ①의 500석 3회는 앞에서 쟀다(500석은 만료 Lua가 10ms를 넘어 SLOWLOG에 남았다)
  async seatrest() {
    kafkaDown();
    const cases = [
      ['five', 'same', true, 3],
      ['five', 'spread', true, 1],
      ['one', 'same', true, 1],
      ['five', 'same', false, 1],
      ['one', 'same', false, 1],
    ];
    let tlsNow = null;
    for (const [mode, layout, tls, reps] of cases) {
      if (tlsNow !== tls) {
        await valkeyUp({ tls });
        tlsNow = tls;
      }
      for (let r = 1; r <= reps; r += 1) {
        const t = tls ? 'tls' : 'notls';
        runBench(`${DAY}-st27-${mode}-${layout}-rb100-${t}-r${r}`, {
          cpus: '2',
          args: ['src/seat-shard.mjs', '--nodes', N, '--tls', String(tls), '--mode', mode, '--layout', layout, '--duration', '600', '--warmup', '60', '--release-batch', '100'],
          ledger: { kpi: 'NFR-003', rps: mode === 'one' ? 2000 : 6000, duration: 600, warmup: 60, scenario: 'loadtest/poc/bench/src/seat-shard.mjs', scenarioArgs: `--mode ${mode} --layout ${layout} --release-batch 100`, redisTls: tls, pairOf: `${DAY}-st27-${mode}-${layout}-rb100-${tls ? 'notls' : 'tls'}-r1`, notes: `S-T27 ${mode === 'one' ? '한 회차 2,000/s' : '다섯 회차 합 6,000/s'}, 배치 ${layout === 'same' ? '한 샤드' : '서로 다른 샤드'}, 만료 작업 Lua 한 번에 100석, 스냅샷·1초 만료·샤드 발행 함께, p99는 클라이언트가 잰 홀드 Lua 왕복` },
        });
      }
    }
    valkeyDown();
  },
  // S-T27 만료 묶음 100개로 다시(첫 회차에서 500개 묶음의 만료 Lua가 SLOWLOG 10ms에 남았다). TLS 켬, ①·② 한 번씩
  async seat100() {
    kafkaDown();
    await valkeyUp({ tls: true });
    for (const [mode, layout] of [['one', 'same'], ['five', 'same']]) {
      runBench(`${DAY}-st27-${mode}-${layout}-rb100-tls-r1`, {
        cpus: '2',
        args: ['src/seat-shard.mjs', '--nodes', N, '--tls', 'true', '--mode', mode, '--layout', layout, '--duration', '600', '--warmup', '60', '--release-batch', '100'],
        ledger: { kpi: 'NFR-003', rps: mode === 'one' ? 2000 : 6000, duration: 600, warmup: 60, scenario: 'loadtest/poc/bench/src/seat-shard.mjs', scenarioArgs: `--mode ${mode} --layout ${layout} --release-batch 100`, redisTls: true, notes: `S-T27 ${mode === 'one' ? '한 회차 2,000/s' : '다섯 회차 합 6,000/s'}, 한 샤드, 만료 작업 Lua 한 번에 100석(첫 회차는 500석), 스냅샷·1초 만료·샤드 발행 함께, p99는 클라이언트가 잰 홀드 Lua 왕복` },
      });
    }
    valkeyDown();
  },
  // S-T27: 10분씩. ① 한 회차 2,000/s ② 다섯 회차 합 6,000/s(한 샤드) ②' 다섯 회차를 서로 다른 샤드에
  async seat() {
    kafkaDown();
    const cases = [
      ['one', 'same', 3],
      ['five', 'same', 3],
      ['five', 'spread', 1],
    ];
    for (const tls of [true, false]) {
      await valkeyUp({ tls });
      for (const [mode, layout, reps] of cases) {
        if (!tls && layout === 'spread') continue;
        for (let r = 1; r <= (tls ? reps : 1); r += 1) {
          const t = tls ? 'tls' : 'notls';
          runBench(`${DAY}-st27-${mode}-${layout}-${t}-r${r}`, {
            cpus: '2',
            args: ['src/seat-shard.mjs', '--nodes', N, '--tls', String(tls), '--mode', mode, '--layout', layout, '--duration', '600', '--warmup', '60'],
            ledger: { kpi: 'NFR-003', rps: mode === 'one' ? 2000 : 6000, duration: 600, warmup: 60, scenario: 'loadtest/poc/bench/src/seat-shard.mjs', scenarioArgs: `--mode ${mode} --layout ${layout}`, redisTls: tls, pairOf: `${DAY}-st27-${mode}-${layout}-${tls ? 'notls' : 'tls'}-r1`, notes: `S-T27 ${mode === 'one' ? '한 회차 2,000/s' : '다섯 회차 합 6,000/s'}, 배치 ${layout === 'same' ? '한 샤드' : '서로 다른 샤드'}, 스냅샷·1초 만료·샤드 발행 함께, p99는 클라이언트가 잰 홀드 Lua 왕복` },
          });
        }
      }
    }
    valkeyDown();
  },
};

async function vt41Run({ config, route, mode, rate, id, k6Cpus = '4', prevus }) {
  tryDocker('rm', '-f', 'vt41');
  docker('run', '-d', '--name', 'vt41', '--hostname', 'vt41', '--network', NET, '--cpus', '1', '-p', '127.0.0.1::9465', '-e', `VT41_CONFIG=${config}`, 'peaket/poc-vt41:local');
  const port = docker('port', 'vt41', '9465/tcp').split('\n')[0].split(':').pop();
  const admin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try {
      await fetch(`${admin}/stats`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const quick = process.env.POC_QUICK === '1'; // 실행기 점검용(장부에 넣지 않는다)
  const warm = quick ? 2 : mode === 'open' ? 15 : 5;
  const dur = quick ? 6 : mode === 'open' ? 60 : 30;
  const env = { BASE: 'http://vt41:8080', ADMIN: 'http://vt41:9465', ROUTE: route, RATE: String(rate ?? 0), DURATION: `${dur}s`, WARMUP: `${warm}s`, WARM_S: String(warm), DUR_S: String(dur), MODE: mode, VUS: '64', NAME: id };
  const startedAt = new Date().toISOString();
  if (prevus) env.PREVUS = String(prevus);
  const k6 = spawn('docker', ['run', '--rm', '--name', `k6-${id}`.slice(0, 60), '--network', NET, '--cpus', k6Cpus, '-v', `${ROOT.replace(/\\/g, '/')}:/repo:ro`, '-v', `${OUT.replace(/\\/g, '/')}:/out`,
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), IMAGES.k6, 'run', '--quiet', '/repo/loadtest/poc/http/vt41.js'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let k6out = '';
  k6.stdout.on('data', (d) => (k6out += d));
  k6.stderr.on('data', (d) => (k6out += d));
  // 앱 쪽 CPU·이벤트 루프 지연은 k6가 본구간 시작에 비우고 끝에 뜬다(vt41.js ctl_reset·ctl_snapshot). 컨테이너 시작·가상 사용자
  // 준비 시간과 상관없이 k6 본구간과 같은 창이다(코드 리뷰 2026-11-01)
  const code = await new Promise((r) => k6.on('close', r));
  const app = await (await fetch(`${admin}/snapshot`)).json();
  tryDocker('rm', '-f', 'vt41');
  writeFileSync(join(OUT, `${id}.k6.log`), k6out);
  const k6File = join(OUT, `${id}.k6.json`);
  if (code !== 0 || !existsSync(k6File)) {
    log(`실패 ${id}: k6 종료 코드 ${code} ${k6out.slice(-800)}`);
    return null;
  }
  const s = JSON.parse(readFileSync(k6File, 'utf8')).metrics;
  const v = (n) => (s[n] && (s[n].values ?? s[n])) || {};
  const reqs = v('http_reqs').count ?? 0;
  const result = {
    test: 'V-T41',
    config,
    route,
    mode,
    offered_rate: rate ?? null,
    app,
    // k6의 부분 지표 rate는 예열을 포함한 전체 시험 시간으로 나눈 값이라 본구간 길이로 다시 나눈다(코드 리뷰 2026-11-01)
    k6: { p50_ms: v('http_req_duration').med, p99_ms: v('http_req_duration')['p(99)'], requests: reqs, rps: Math.round(reqs / dur), failed_rate: v('http_req_failed').rate, dropped: v('dropped_iterations').count ?? 0 },
    cpu_us_per_request: app.handled ? Math.round((app.cpu_us / app.handled) * 10) / 10 : null,
    throughput_per_s: Math.round(app.handled / (app.wall_us / 1e6)),
  };
  result.bench = { p99_ms: result.k6.p99_ms, error_rate: result.k6.failed_rate, requests: reqs, dropped: result.k6.dropped };
  writeFileSync(join(OUT, `${id}.json`), JSON.stringify(result, null, 2));
  record({ id, startedAt, endedAt: new Date().toISOString(), cpus: `1(앱)·${k6Cpus}(k6)`, kpi: 'V-T41', rps: rate ?? null, duration: dur, warmup: warm, closed: mode === 'closed', scenario: 'loadtest/poc/http/vt41.js', scenarioArgs: `MODE=${mode} ROUTE=${route} RATE=${rate ?? '-'} VT41_CONFIG=${config} PREVUS=${prevus ?? 2000} k6 --cpus ${k6Cpus}`, k6: true, notes: `V-T41 ${config} ${route}, 앱 컨테이너 CPU 1, k6 1.4.2 CPU ${k6Cpus}·미리 만든 가상 사용자 ${prevus ?? (mode === 'open' ? '200 또는 2000' : '-')}, 요청당 CPU ${result.cpu_us_per_request}µs, 이벤트 루프 지연 p99 ${app.eld_ms.p99}ms` });
  log(`끝 ${id}: p99 ${result.k6.p99_ms}ms, 처리 ${result.throughput_per_s}/s, 요청당 CPU ${result.cpu_us_per_request}µs`);
  return result;
}

export { vt41Run };
if (process.env.POC_NO_MAIN === '1') process.exitCode = 0;
const want = process.env.POC_NO_MAIN === '1' ? null : process.argv.slice(2);
if (want === null) {
  // 가져오기만 한다
} else {
const order = want.length ? want : ['incr', 'clients', 'behaviors', 'vt41', 'kafka', 'seat'];
log(`시작: ${order.join(', ')}`);
await syncEntryLua();
build();
execFileSync('docker', ['build', '-q', '-f', 'packages/platform/bench/vt41/Dockerfile', '-t', 'peaket/poc-vt41:local', '.'], { cwd: ROOT, stdio: 'ignore' });
for (const g of order) {
  log(`묶음 ${g}`);
  try {
    await groups[g]();
  } catch (err) {
    log(`묶음 ${g} 실패: ${String(err.stack ?? err).slice(0, 800)}`);
  }
}
valkeyDown();
kafkaDown();
log('모두 끝');
}
