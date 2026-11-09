// PoC 측정 공통 도구(wbs 0.5.1). 의존성 없음.
// - 오픈 모델: 정해진 도착률로 요청을 '보내기로 한 시각'에 내고, 지연을 그 시각부터 잰다(응답을 기다린 뒤 다음을 보내지 않는다,
//   docs/verification.md §3.5 1번). 발생기가 뒤처지면 그 지연이 측정값에 그대로 들어간다.
// - 동시에 기다리는 요청이 상한을 넘으면 그 요청은 보내지 않고 '못 보낸 요청'(k6 dropped_iterations와 같은 뜻)으로 센다.
//   하나라도 있으면 그 측정은 무효다(§3.5 2번).
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';

export const now = () => Number(process.hrtime.bigint());
const LOG_STEP = Math.log(1.01);

/** 칸 히스토그램 여럿을 합쳐 백분위를 낸다. 값은 칸의 위 경계라 실제보다 최대 1% 크다 */
export function mergeHistograms(hs) {
  const sum = {};
  let n = 0;
  for (const h of hs) for (const [i, c] of Object.entries(h)) {
    sum[i] = (sum[i] ?? 0) + c;
    n += c;
  }
  const idx = Object.keys(sum).map(Number).sort((x, y) => x - y);
  const at = (p) => {
    const want = Math.ceil(p * n);
    let acc = 0;
    for (const i of idx) {
      acc += sum[i];
      if (acc >= want) return Math.round(Math.exp((i + 1) * LOG_STEP)) / 1000;
    }
    return null;
  };
  return { count: n, p50_ms: at(0.5), p90_ms: at(0.9), p99_ms: at(0.99), p999_ms: at(0.999), max_ms: idx.length ? Math.round(Math.exp((idx[idx.length - 1] + 1) * LOG_STEP)) / 1000 : null };
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 지연(나노초)을 모아 백분위를 낸다. 값 전체를 두고 정렬하므로 정확한 순위 백분위다 */
export class Recorder {
  #chunks = [];
  #cur = new Float64Array(1 << 16);
  #n = 0;
  count = 0;
  add(ns) {
    if (this.#n === this.#cur.length) {
      this.#chunks.push(this.#cur);
      this.#cur = new Float64Array(1 << 16);
      this.#n = 0;
    }
    this.#cur[this.#n++] = ns;
    this.count += 1;
  }
  /** 1% 간격 로그 칸(마이크로초)으로 센다. 여러 프로세스의 분포를 합칠 때 쓴다(mergeHistograms) */
  histogram() {
    const h = {};
    const each = (v) => {
      const us = Math.max(1, v / 1e3);
      const i = Math.floor(Math.log(us) / LOG_STEP);
      h[i] = (h[i] ?? 0) + 1;
    };
    for (const c of this.#chunks) for (const v of c) each(v);
    for (let i = 0; i < this.#n; i += 1) each(this.#cur[i]);
    return h;
  }
  summary() {
    const all = new Float64Array(this.count);
    let o = 0;
    for (const c of this.#chunks) {
      all.set(c, o);
      o += c.length;
    }
    all.set(this.#cur.subarray(0, this.#n), o);
    all.sort();
    const q = (p) => (all.length ? all[Math.min(all.length - 1, Math.ceil(p * all.length) - 1)] / 1e6 : null);
    let sum = 0;
    for (const v of all) sum += v;
    const r = (v) => (v === null ? null : Math.round(v * 1000) / 1000);
    return {
      count: all.length,
      p50_ms: r(q(0.5)),
      p90_ms: r(q(0.9)),
      p99_ms: r(q(0.99)),
      p999_ms: r(q(0.999)),
      max_ms: r(all.length ? all[all.length - 1] / 1e6 : null),
      mean_ms: r(all.length ? sum / all.length / 1e6 : null),
    };
  }
}

/**
 * 정해진 도착률로 op(i)를 부른다. 1ms마다 밀린 만큼 낸다.
 * @returns 보낸 수·끝난 수·오류·못 보낸 수, 예열 뒤 지연 요약, 실제 낸 비율
 */
export async function openLoop({ rate, durationS, warmupS = 0, maxInflight = 10_000, op, onError, withHistogram = false }) {
  const total = Math.floor(rate * durationS);
  const interval = 1e9 / rate;
  const warmEnd = warmupS * rate;
  const rec = new Recorder();
  // 실제로 보낸 시각부터 잰 지연(1ms 박자에서 기다린 몫을 뺀 값, 비교용). 판정은 보내기로 한 시각 기준(rec)으로 한다
  const sendRec = new Recorder();
  let issued = 0;
  let done = 0;
  let errors = 0;
  let dropped = 0;
  let inflight = 0;
  let maxSeenInflight = 0;
  const errorKinds = new Map();
  const t0 = now() + 20e6;
  await new Promise((resolve) => {
    const finishIfDone = () => {
      if (issued === total && inflight === 0) resolve();
    };
    const pump = () => {
      const due = Math.min(total, Math.floor((now() - t0) / interval) + 1);
      while (issued < due) {
        const i = issued;
        issued += 1;
        if (inflight >= maxInflight) {
          dropped += 1;
          continue;
        }
        inflight += 1;
        if (inflight > maxSeenInflight) maxSeenInflight = inflight;
        const sched = t0 + i * interval;
        const sent = now();
        let p;
        try {
          p = op(i);
        } catch (err) {
          p = Promise.reject(err);
        }
        p.then(
          () => {
            if (i >= warmEnd) {
              const t = now();
              rec.add(t - sched);
              sendRec.add(t - sent);
            }
          },
          (err) => {
            if (i >= warmEnd) errors += 1;
            const k = (err && (err.name + ': ' + String(err.message).slice(0, 80))) || String(err);
            errorKinds.set(k, (errorKinds.get(k) ?? 0) + 1);
            onError?.(err);
          },
        ).finally(() => {
          inflight -= 1;
          done += 1;
          finishIfDone();
        });
      }
      if (issued < total) setTimeout(pump, 1);
      else finishIfDone();
    };
    setTimeout(pump, 20);
  });
  // 예열 뒤에 보내기로 한 요청 수(오류율의 분모, 장부의 요청 수)
  const measured = total - Math.ceil(warmEnd);
  return {
    offered_rate: rate,
    measured,
    duration_s: durationS,
    warmup_s: warmupS,
    issued,
    done,
    dropped,
    errors,
    error_rate: measured > 0 ? errors / measured : 0,
    max_inflight: maxSeenInflight,
    error_kinds: Object.fromEntries(errorKinds),
    latency: rec.summary(),
    latency_from_send: sendRec.summary(),
    hist: withHistogram ? rec.histogram() : undefined,
  };
}

/** 닫힌 모델(동시에 conc개를 계속 돌린다): 최대 처리량을 잴 때만 쓴다. 지연은 참고값이다(coordinated omission) */
export async function closedLoop({ conc, durationS, warmupS = 0, op }) {
  const rec = new Recorder();
  let count = 0;
  let errors = 0;
  const start = now();
  const warmEnd = start + warmupS * 1e9;
  const end = start + (warmupS + durationS) * 1e9;
  const worker = async () => {
    for (let i = 0; ; i += 1) {
      const t = now();
      if (t >= end) return;
      try {
        await op(i);
        if (t >= warmEnd) {
          rec.add(now() - t);
          count += 1;
        }
      } catch {
        if (t >= warmEnd) errors += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: conc }, worker));
  return { conc, duration_s: durationS, warmup_s: warmupS, completed: count, errors, throughput_per_s: Math.round(count / durationS), latency: rec.summary() };
}

/** Docker VM 전체 CPU(/proc/stat, 이름 공간에 갇히지 않는다)와 실행 대기 프로세스 수(docs/verification.md §3.5 6번) */
export function hostSample() {
  try {
    const s = readFileSync('/proc/stat', 'utf8');
    const cpu = s.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    const idle = cpu[3] + (cpu[4] ?? 0);
    const totalT = cpu.reduce((a, b) => a + b, 0);
    const running = Number(/procs_running (\d+)/.exec(s)?.[1] ?? NaN);
    return { idle, total: totalT, running, at: now() };
  } catch {
    return null;
  }
}

export function hostDelta(a, b) {
  if (!a || !b) return null;
  const busy = 1 - (b.idle - a.idle) / (b.total - a.total);
  return { cpu_pct: Math.round(busy * 1000) / 10, procs_running_end: b.running, vm_cpus: cpus().length };
}

/** 이 프로세스(발생기)의 CPU 사용률(한 코어 = 100) */
export function procCpu() {
  const t = process.hrtime.bigint();
  const u = process.cpuUsage();
  return () => {
    const du = process.cpuUsage(u);
    const dt = Number(process.hrtime.bigint() - t) / 1000;
    return Math.round(((du.user + du.system) / dt) * 1000) / 10;
  };
}

export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    out[k] = v;
  }
  return out;
}

export function writeResult(path, obj) {
  const text = JSON.stringify(obj, null, 2);
  if (path) writeFileSync(path, text + '\n');
  console.log(text);
}

/**
 * 두 종류가 섞인 한 분포(엔진 명령별 지연, 예: 홀드·만료 Lua가 둘 다 EVALSHA)에서 많은 쪽(nAll − nx번)의 p99를 읽을 백분위(0~100).
 * 섞인 분포에서 그 p99 v 이하의 몫은 (0.99·(nAll − nx) + f·nx)/nAll이다(f = 적은 쪽 nx번 가운데 v보다 빠른 몫).
 * @param {number} nAll 섞인 호출 수
 * @param {number} nx 적은 쪽(만료) 호출 수
 * @param {number} nxFast 적은 쪽 가운데 v보다 빠를 수 있다고 보는 호출 수(0 ~ nx)
 * @returns {{ lo: number, est: number, hi: number }} lo: f = 0(아래 끝, 내림), est: f = nxFast/nx(올림), hi: f = 1(위 끝, 올림). 소수 넷째 자리까지
 */
export function mixedP99Percentiles(nAll, nx, nxFast) {
  if (!(nAll > 0) || nx < 0 || nx > nAll || nxFast < 0 || nxFast > nx) throw new RangeError(`호출 수가 틀렸다: nAll ${nAll}, nx ${nx}, nxFast ${nxFast}`);
  const q = (fast) => Math.min(100, (99 * (nAll - nx) + 100 * fast) / nAll);
  return { lo: Math.floor(q(0) * 1e4) / 1e4, est: Math.min(100, Math.ceil(q(nxFast) * 1e4) / 1e4), hi: Math.min(100, Math.ceil(q(nx) * 1e4) / 1e4) };
}

// ---- Redis 클러스터 슬롯(CRC16/XMODEM, Redis Cluster 명세) ----
const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i << 8;
    for (let j = 0; j < 8; j += 1) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    t[i] = c;
  }
  return t;
})();
export function slotOf(key) {
  let k = key;
  const s = key.indexOf('{');
  if (s >= 0) {
    const e = key.indexOf('}', s + 1);
    if (e > s + 1) k = key.slice(s + 1, e);
  }
  let crc = 0;
  for (const b of Buffer.from(k)) crc = ((crc << 8) & 0xffff) ^ CRC_TABLE[((crc >> 8) ^ b) & 0xff];
  return crc % 16384;
}
