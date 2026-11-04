// S-T27 오버셀 검사(docs/features/seat-hold.md S-T27 '오버셀 0건', §8 'S-T27 다시 재기'). 의존성 없음.
// 운영 홀드 Lua의 펜싱 토큰은 max(fence + 1, Redis TIME µs)라 약 1.7e15이다(hold-lua.ts). 예전 검사는 Int32 배열과 '토큰 × 2^17' 한 값에
// 담아 이 크기에서 넘쳤다. 그래서 64비트 실수(Float64Array, 2^53 아래 정수는 정확하다)에 담고 마이크로초 순서로 맞춘다.
//
// 순서 규칙(서버 실행 순서를 되살린다)
// - 잡기의 시각 = 그 홀드의 토큰. 회차마다 엄격히 늘고, 잡은 순간의 µs 이상이다.
// - 놓기의 시각 = 만료 Lua가 돌려준 '지금 µs'(TIME). 그 Lua가 푼 좌석마다 (µs, 좌석, 푼 홀드의 토큰)을 남긴다.
// - 같은 좌석에서 시각이 같으면 놓기가 먼저다(놓은 Lua 바로 뒤 같은 µs에 다른 홀드가 잡으면 토큰 = 그 µs가 될 수 있다).
// - 잡은 뒤 같은 좌석을 놓으려면 exp(= 잡은 시각 + TTL) ≤ 지금이어야 하므로, 토큰이 TIME보다 TTL 넘게 앞서지 않는 한(측정은 FLUSHALL 뒤라
//   토큰 = µs) 잡기 시각 < 놓기 시각이다. 측정 중 VM 벽시계가 뒤로 가면 순서가 틀어질 수 있다(그때는 오버셀이 거짓으로 잡힌다).
// 판정: 좌석마다 시각 순으로 잡기·놓기가 번갈아 오고, 놓기가 푼 토큰이 바로 앞 잡기의 토큰과 같아야 한다.

/** 정렬 값 = 시각 × 2 + 종류(놓기 0, 잡기 1). 2^53 아래에서 정확하려면 시각 < 2^52(µs로 2112년)여야 한다 */
export const MAX_TIME_US = 2 ** 52;

/** 늘어나는 Float64 배열(기록을 JS 배열로 쌓으면 수백만 개에서 GC가 길게 멈춰 측정값에 섞였다, ADR-0176 결정 3 '무효로 남긴 측정') */
export class GrowF64 {
  buf = new Float64Array(1 << 16);
  n = 0;
  push(x) {
    if (this.n === this.buf.length) {
      const b = new Float64Array(this.buf.length * 2);
      b.set(this.buf);
      this.buf = b;
    }
    this.buf[this.n++] = x;
  }
}

export class GrowI32 {
  buf = new Int32Array(1 << 16);
  n = 0;
  push(x) {
    if (this.n === this.buf.length) {
      const b = new Int32Array(this.buf.length * 2);
      b.set(this.buf);
      this.buf = b;
    }
    this.buf[this.n++] = x;
  }
}

const checkTime = (t, what) => {
  if (!Number.isSafeInteger(t) || t < 0 || t >= MAX_TIME_US) throw new RangeError(`${what}이(가) 0 이상 2^52 미만의 정수가 아니다: ${t}`);
};
const checkSeat = (s) => {
  if (!Number.isInteger(s) || s < 0 || s > 0x7fffffff) throw new RangeError(`좌석 색인이 틀렸다: ${s}`);
};

/** 회차 하나의 잡기·놓기 기록 */
export class SeatLog {
  holdTok = new GrowF64();
  holdSeat = new GrowI32();
  relUs = new GrowF64();
  relSeat = new GrowI32();
  relTok = new GrowF64();
  /** 홀드 Lua OK 하나의 좌석 하나 */
  hold(token, seat) {
    checkTime(token, '잡기 토큰');
    checkSeat(seat);
    this.holdTok.push(token);
    this.holdSeat.push(seat);
  }
  /** 만료 Lua가 푼 좌석 하나(그 Lua의 지금 µs, 좌석, 푼 홀드의 토큰) */
  release(nowUs, seat, token) {
    checkTime(nowUs, '놓기 µs');
    checkTime(token, '놓은 토큰');
    checkSeat(seat);
    this.relUs.push(nowUs);
    this.relSeat.push(seat);
    this.relTok.push(token);
  }
  get holds() {
    return this.holdTok.n;
  }
  get releases() {
    return this.relUs.n;
  }
}

/**
 * 좌석마다 시각 순으로 잡기·놓기가 번갈아 오는지 본다.
 * @param {SeatLog} log
 * @param {number} seatCount 회차 좌석 수(색인은 0 ~ seatCount − 1)
 * @param {Float64Array} [heldOut] 주면(길이 seatCount) 좌석마다 기록대로 끝에 잡고 있는 홀드의 토큰을 채운다(비어 있으면 −1). compareSeats에 넘긴다
 * @returns {{ oversell: number, unknown_release: number, held_at_end: number, holds: number, releases: number }}
 *   oversell: 잡혀 있는 좌석을 또 잡은 수. unknown_release: 비어 있는 좌석을 놓았거나 놓은 토큰이 지금 잡은 홀드의 것이 아닌 수.
 *   held_at_end: 기록대로면 끝에 잡혀 있는 좌석 수(오류 없는 측정이면 켜진 비트 수와 같아야 한다)
 */
export function checkOversell(log, seatCount, heldOut) {
  if (heldOut) heldOut.fill(-1);
  const nh = log.holdTok.n;
  const nr = log.relUs.n;
  const n = nh + nr;
  // 좌석마다 모은다(계수 정렬). 항목 번호 0..nh−1은 잡기, nh..n−1은 놓기
  const start = new Uint32Array(seatCount + 1);
  const seatOf = (k) => (k < nh ? log.holdSeat.buf[k] : log.relSeat.buf[k - nh]);
  for (let k = 0; k < n; k += 1) {
    const s = seatOf(k);
    if (s >= seatCount) throw new RangeError(`좌석 색인 ${s}이(가) 좌석 수 ${seatCount} 밖이다`);
    start[s + 1] += 1;
  }
  for (let s = 0; s < seatCount; s += 1) start[s + 1] += start[s];
  const pos = start.slice(0, seatCount);
  const order = new Uint32Array(n);
  for (let k = 0; k < n; k += 1) order[pos[seatOf(k)]++] = k;
  const key = new Float64Array(n);
  for (let k = 0; k < nh; k += 1) key[k] = log.holdTok.buf[k] * 2 + 1;
  for (let k = 0; k < nr; k += 1) key[nh + k] = log.relUs.buf[k] * 2;
  let oversell = 0;
  let unknownRelease = 0;
  let heldAtEnd = 0;
  for (let s = 0; s < seatCount; s += 1) {
    const a = start[s];
    const b = start[s + 1];
    if (a === b) continue;
    const g = order.subarray(a, b);
    if (b - a > 1) g.sort((x, y) => key[x] - key[y]);
    let holder = -1; // 지금 잡은 홀드의 토큰(−1 = 비어 있음)
    for (const k of g) {
      if (k < nh) {
        if (holder !== -1) oversell += 1;
        holder = log.holdTok.buf[k];
      } else {
        if (holder === -1 || holder !== log.relTok.buf[k - nh]) unknownRelease += 1;
        holder = -1;
      }
    }
    if (holder !== -1) heldAtEnd += 1;
    if (heldOut) heldOut[s] = holder;
  }
  return { oversell, unknown_release: unknownRelease, held_at_end: heldAtEnd, holds: nh, releases: nr };
}

/** Redis 비트맵(GET의 바이트)에서 좌석 색인의 비트(SETBIT과 같은 차례: 바이트마다 높은 비트가 앞) */
export const bitAt = (bitmap, index) => ((bitmap[index >> 3] ?? 0) >> (7 - (index & 7))) & 1;

/**
 * 끝에 좌석마다 기록과 저장소를 견준다(총수만 같으면 놓치는 것을 잡는다. 측정이 끝난 뒤 한 번만 부른다).
 * - bit_without_log: 비트는 켜졌는데 기록으로는 비어 있다(기록에 빠진 잡기, 또는 놓기가 비트를 끄지 않았다)
 * - log_without_bit: 기록으로는 잡혀 있는데 비트가 꺼졌다(놓기 기록 없이 꺼진 비트)
 * - index_without_log·log_without_index: 만료 인덱스 멤버와 기록이 다르다
 * @param {Float64Array} held checkOversell의 heldOut(−1 = 비어 있음)
 * @param {Uint8Array} bitmap 비트맵 키의 바이트(GET, 짧으면 뒤는 0으로 본다)
 * @param {Iterable<number>} indexMembers 만료 인덱스의 좌석 색인들
 * @returns {{ bit_without_log: number, log_without_bit: number, index_without_log: number, log_without_index: number, sample: number[] }}
 *   sample은 어긋난 좌석 색인 앞의 10개(차례대로)
 */
export function compareSeats(held, bitmap, indexMembers) {
  const n = held.length;
  const inIndex = new Uint8Array(n);
  let indexOutside = 0;
  for (const i of indexMembers) {
    if (Number.isInteger(i) && i >= 0 && i < n) inIndex[i] = 1;
    else indexOutside += 1;
  }
  const r = { bit_without_log: 0, log_without_bit: 0, index_without_log: indexOutside, log_without_index: 0, sample: [] };
  const miss = (i) => r.sample.length < 10 && r.sample.push(i);
  for (let i = 0; i < n; i += 1) {
    const logged = held[i] !== -1;
    const bit = bitAt(bitmap, i) === 1;
    if (bit && !logged) {
      r.bit_without_log += 1;
      miss(i);
    } else if (!bit && logged) {
      r.log_without_bit += 1;
      miss(i);
    }
    if (inIndex[i] && !logged) r.index_without_log += 1;
    else if (!inIndex[i] && logged) r.log_without_index += 1;
  }
  // 좌석 수 밖에 켜진 비트(비트맵 길이는 좌석 수를 8로 올림한 바이트다)
  for (let i = n; i < bitmap.length * 8; i += 1) {
    if (bitAt(bitmap, i) === 1) {
      r.bit_without_log += 1;
      miss(i);
    }
  }
  return r;
}
