// F-04-9 합성 시나리오 생성기와 공유 주소. 정본: docs/features/forensic-replay.md §5.1~§5.4·§8 FX-T1.
// 시드·매개변수·생성기 판이 같으면 같은 열 배열이 나온다. 시계·난수·저장소를 직접 쓰지 않는다.
// 봇 등급표 12칸은 '물량·속도·계정·대기열 × 1~3단계'이고, 이 파일은 클래스와 단계를 정답으로 남긴다.
import { sampleEntropy, sampleExponential, sampleResponse } from './cdf.ts';
import {
  EVENT_KIND,
  LOBBY_MS,
  MAX_EVENTS,
  MAX_SEATS,
  MAX_WINDOW_MS,
  MIN_SEATS,
  NET_TYPE,
  NO_SEAT,
  RESULT,
  SCHEMA_NAME,
  type EventColumns,
  type ForensicMeta,
  makeColumns,
} from './events.ts';
import { DEFAULT_SEED, Xoshiro128 } from './prng.ts';
import { ceilPositive, roundPositive } from './math.ts';

export type PresetId = 'concert' | 'sports' | 'mimic';
export type Ordering = 'fifo' | 'hybrid';
export type Layout = 'arena' | 'circular';
export type BotClass = 'VOLUME' | 'SPEED' | 'ACCOUNT' | 'QUEUE';

export interface Preset {
  id: PresetId;
  label: string;
  seats: number;
  queueSize: number;
  botRatio: number;
  ordering: Ordering;
  layout: Layout;
  mimicBots: boolean;
}

export const PRESETS: Record<PresetId, Preset> = {
  concert: {
    id: 'concert',
    label: '인기 콘서트 오픈',
    seats: 50_000,
    queueSize: 300_000,
    botRatio: 0.3,
    ordering: 'hybrid',
    layout: 'arena',
    mimicBots: false,
  },
  sports: {
    id: 'sports',
    label: '스포츠 플레이오프 오픈',
    seats: 30_000,
    queueSize: 150_000,
    botRatio: 0.1,
    ordering: 'fifo',
    layout: 'circular',
    mimicBots: false,
  },
  mimic: {
    id: 'mimic',
    label: '사람 흉내 봇',
    seats: 30_000,
    queueSize: 150_000,
    botRatio: 0.3,
    ordering: 'hybrid',
    layout: 'circular',
    mimicBots: true,
  },
};

export const DEFAULT_GENERATOR_VERSION = 2;
export const SALE_START_ISO = '2026-11-28T09:00:00.000Z';

export interface ScenarioParams {
  preset: PresetId;
  seed: string;
  generatorVersion: number;
  seats: number;
  sectionCount: number;
  queueSize: number;
  windowMs: number;
  botRatio: number;
  ordering: Ordering;
  layout: Layout;
  mimicBots: boolean;
}

export interface SessionTruth {
  session: number;
  isBot: boolean;
  botClass: BotClass | null;
  botTier: number;
  entropy: number;
  firstHoldMs: number | null;
  deviceGroup: number;
  netType: number;
  asn: number;
  queueEnterMs: number;
  admitMs: number | null;
}

export interface SeatTransition {
  tMs: number;
  seat: number;
  state: number;
  session: number;
}

export interface ScenarioTruth {
  seatCount: number;
  sessions: SessionTruth[];
  transitions: SeatTransition[];
}

export interface ScenarioStats {
  eventCount: number;
  sessionCount: number;
  admittedCount: number;
  botCount: number;
}

export interface Scenario {
  meta: ForensicMeta;
  columns: EventColumns;
  truth: ScenarioTruth;
  stats: ScenarioStats;
}

export type ParamsValidation = { ok: true } | { ok: false; field: string; message: string };

const SEED_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const BOT_CLASSES: readonly BotClass[] = ['VOLUME', 'SPEED', 'ACCOUNT', 'QUEUE'];

export function defaultParams(preset: PresetId, seed: string = DEFAULT_SEED): ScenarioParams {
  const base = PRESETS[preset];
  return {
    preset,
    seed,
    generatorVersion: DEFAULT_GENERATOR_VERSION,
    seats: base.seats,
    sectionCount: preset === 'concert' ? 20 : 12,
    queueSize: base.queueSize,
    windowMs: MAX_WINDOW_MS,
    botRatio: base.botRatio,
    ordering: base.ordering,
    layout: base.layout,
    mimicBots: base.mimicBots,
  };
}

function fail(field: string, message: string): ParamsValidation {
  return { ok: false, field, message };
}

export function validateParams(params: ScenarioParams): ParamsValidation {
  if (!Object.prototype.hasOwnProperty.call(PRESETS, params.preset)) return fail('preset', '모르는 프리셋입니다');
  if (!SEED_PATTERN.test(params.seed)) return fail('seed', '시드는 영문·숫자·._- 1~64자입니다');
  if (params.generatorVersion !== DEFAULT_GENERATOR_VERSION) return fail('generatorVersion', '생성기 판이 다릅니다');
  if (!Number.isInteger(params.seats) || params.seats < MIN_SEATS || params.seats > MAX_SEATS) {
    return fail('seats', '좌석 수는 1,000~100,000입니다');
  }
  if (!Number.isInteger(params.sectionCount) || params.sectionCount < 1 || params.sectionCount > 65_535) {
    return fail('sectionCount', '구역 수가 범위를 벗어났습니다');
  }
  if (!Number.isInteger(params.queueSize) || params.queueSize < 1 || params.queueSize > 2_000_000) {
    return fail('queueSize', '대기 인원은 1~2,000,000입니다');
  }
  if (!Number.isInteger(params.windowMs) || params.windowMs < 60_000 || params.windowMs > MAX_WINDOW_MS) {
    return fail('windowMs', '시간창은 1분~30분입니다');
  }
  if (!Number.isFinite(params.botRatio) || params.botRatio < 0 || params.botRatio > 0.6) {
    return fail('botRatio', '봇 비율은 0~60%입니다');
  }
  if (params.ordering !== 'fifo' && params.ordering !== 'hybrid') return fail('ordering', '정렬 방식이 다릅니다');
  if (params.layout !== 'arena' && params.layout !== 'circular') return fail('layout', '배치가 다릅니다');
  if (typeof params.mimicBots !== 'boolean') return fail('mimicBots', '사람 흉내 여부가 참·거짓이 아닙니다');

  const admitted = Math.min(params.queueSize, ceilPositive(params.seats * 1.5));
  if (params.queueSize + admitted * 20 > MAX_EVENTS) return fail('queueSize', '사건 상한 300만을 넘을 수 있습니다');
  return { ok: true };
}

function canonicalParams(params: ScenarioParams): string {
  return [
    params.preset,
    params.seed,
    params.generatorVersion,
    params.seats,
    params.sectionCount,
    params.queueSize,
    params.windowMs,
    params.botRatio,
    params.ordering,
    params.layout,
    params.mimicBots ? '1' : '0',
  ].join('|');
}

function shuffle<T>(items: T[], rng: Xoshiro128): void {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = rng.nextInt(i + 1);
    const value = items[i];
    items[i] = items[j];
    items[j] = value;
  }
}

interface Draft {
  t: number;
  seq: number;
  kind: number;
  seat: number;
  section: number;
  session: number;
  result: number;
  retry: number;
  latency: number;
  firstHold: number;
  entropy: number;
  netType: number;
  asn: number;
  deviceGroup: number;
  botTier: number;
}

function applyTruth(state: Uint8Array, transitions: SeatTransition[], draft: Draft): void {
  if (draft.seat === NO_SEAT || draft.seat >= state.length) return;
  const seat = draft.seat;
  if (draft.kind === EVENT_KIND.HOLD_TRY && draft.result === RESULT.HELD) {
    if (state[seat] !== 0) return;
    state[seat] = 1;
  } else if (draft.kind === EVENT_KIND.HOLD_END) {
    if (state[seat] !== 1) return;
    state[seat] = 0;
  } else if (draft.kind === EVENT_KIND.PAY_TRY) {
    if (state[seat] !== 3) state[seat] = 2;
  } else if (draft.kind === EVENT_KIND.SALE) {
    if (state[seat] !== 2) return;
    state[seat] = 3;
  } else if (draft.kind === EVENT_KIND.PAY_FAIL) {
    if (state[seat] !== 2) return;
    state[seat] = 0;
  } else {
    return;
  }
  transitions.push({ tMs: draft.t, seat, state: state[seat], session: draft.session });
}

export function generateScenario(params: ScenarioParams): Scenario {
  const check = validateParams(params);
  if (!check.ok) throw new Error(`시나리오 매개변수가 틀렸습니다: ${check.field} ${check.message}`);

  const canonical = canonicalParams(params);
  const queueRng = new Xoshiro128(`${canonical}|queue`);
  const botRng = new Xoshiro128(`${canonical}|bots`);
  const valueRng = new Xoshiro128(`${canonical}|values`);
  const seatRng = new Xoshiro128(`${canonical}|seats`);
  const admitRng = new Xoshiro128(`${canonical}|admit`);
  const sessionCount = params.queueSize;
  const windowMs = params.windowMs;

  const queueEnter = new Int32Array(sessionCount);
  for (let i = 0; i < sessionCount; i += 1) {
    const spread = LOBBY_MS / sessionCount;
    const jitter = Math.floor(sampleExponential(queueRng) * spread * 0.4);
    const base = -LOBBY_MS + Math.floor((i * LOBBY_MS) / sessionCount) + jitter;
    queueEnter[i] = Math.max(-LOBBY_MS, Math.min(0, base));
  }

  const isBot = new Uint8Array(sessionCount);
  const botCount = Math.min(sessionCount, roundPositive(sessionCount * params.botRatio));
  const botOrder = Array.from({ length: sessionCount }, (_, i) => i);
  shuffle(botOrder, botRng);
  for (let i = 0; i < botCount; i += 1) isBot[botOrder[i]] = 1;

  const botClass: Array<BotClass | null> = new Array(sessionCount).fill(null);
  const botTier = new Uint8Array(sessionCount);
  const entropy = new Float32Array(sessionCount);
  const firstHold = new Uint32Array(sessionCount);
  const deviceGroup = new Uint32Array(sessionCount);
  const netType = new Uint8Array(sessionCount);
  const asn = new Uint32Array(sessionCount);

  for (let i = 0; i < sessionCount; i += 1) {
    const bot = isBot[i] === 1;
    let cls: BotClass | null = null;
    let tier = 0;
    if (bot) {
      cls = BOT_CLASSES[botRng.nextInt(BOT_CLASSES.length)];
      tier = params.mimicBots ? 3 : 1 + botRng.nextInt(3);
      botClass[i] = cls;
      botTier[i] = tier;
    }
    const behavior = bot && !params.mimicBots ? 'bot' : 'human';
    entropy[i] = Math.fround(sampleEntropy(valueRng, behavior));
    firstHold[i] = Math.max(1, roundPositive(sampleResponse(valueRng, behavior)));
    deviceGroup[i] = 1 + ((bot && cls === 'VOLUME') ? (i >> 3) : (i >> 1));
    const network = valueRng.nextUnit();
    if (!bot) {
      netType[i] = network < 0.7 ? NET_TYPE.MOBILE : NET_TYPE.WIFI;
    } else if (network < 0.45) {
      netType[i] = NET_TYPE.MOBILE;
    } else if (network < 0.8) {
      netType[i] = NET_TYPE.WIFI;
    } else if (network < 0.92) {
      netType[i] = NET_TYPE.HOSTING;
    } else {
      netType[i] = NET_TYPE.PROXY;
    }
    if (netType[i] === NET_TYPE.HOSTING || netType[i] === NET_TYPE.PROXY) {
      asn[i] = 400_000 + valueRng.nextInt(100_000);
    }
  }

  const admittedCount = Math.min(sessionCount, Math.max(1, ceilPositive(params.seats * 1.5)));
  const order = Array.from({ length: sessionCount }, (_, i) => i);
  if (params.ordering === 'fifo') {
    order.sort((a, b) => queueEnter[a] - queueEnter[b] || a - b);
  } else {
    shuffle(order, admitRng);
  }
  const admitAt = new Int32Array(sessionCount).fill(-1);
  const admitWindow = Math.min(Math.floor(windowMs * 0.5), 15 * 60_000);
  for (let rank = 0; rank < admittedCount; rank += 1) {
    const session = order[rank];
    admitAt[session] = Math.min(windowMs, Math.floor((rank * admitWindow) / admittedCount));
  }

  const freeAt = new Float64Array(params.seats).fill(-1);
  const sold = new Uint8Array(params.seats);
  const drafts: Draft[] = [];
  let sequence = 0;

  const sectionOfSeat = (seat: number) => Math.min(params.sectionCount - 1, Math.floor((seat * params.sectionCount) / params.seats));
  const available = (seat: number, t: number) => sold[seat] === 0 && freeAt[seat] <= t;

  const push = (t: number, session: number, kind: number, extra: Partial<Draft> = {}): void => {
    if (!Number.isFinite(t) || t < -LOBBY_MS || t > windowMs) return;
    const seat = extra.seat ?? NO_SEAT;
    drafts.push({
      t: Math.trunc(t),
      seq: sequence,
      kind,
      seat,
      section: extra.section ?? (seat === NO_SEAT ? 0 : sectionOfSeat(seat)),
      session,
      result: extra.result ?? RESULT.NONE,
      retry: extra.retry ?? 0,
      latency: extra.latency ?? 0,
      firstHold: extra.firstHold ?? 0,
      entropy: entropy[session],
      netType: netType[session],
      asn: asn[session],
      deviceGroup: deviceGroup[session],
      botTier: botTier[session],
    });
    sequence += 1;
  };

  for (let session = 0; session < sessionCount; session += 1) {
    push(queueEnter[session], session, EVENT_KIND.QUEUE_ENTER);
  }

  for (let rank = 0; rank < admittedCount; rank += 1) {
    const session = order[rank];
    if (admitAt[session] >= 0) {
      push(admitAt[session], session, EVENT_KIND.ADMIT, { firstHold: firstHold[session] });
    }
  }

  for (let rank = 0; rank < admittedCount; rank += 1) {
    const session = order[rank];
    const admit = admitAt[session];
    if (admit < 0) continue;
    const firstHoldAt = admit + firstHold[session];
    if (firstHoldAt > windowMs) continue;

    const bot = isBot[session] === 1;
    const volume = bot && !params.mimicBots && botClass[session] === 'VOLUME';
    const desired = !bot ? (valueRng.nextUnit() < 0.2 ? 2 : 1) : volume ? 3 + valueRng.nextInt(4) : 1 + valueRng.nextInt(2);
    let previousSeat = -1;

    for (let attempt = 0; attempt < desired && attempt < 6; attempt += 1) {
      const t = firstHoldAt + attempt * (400 + valueRng.nextInt(1_200));
      if (t > windowMs) break;

      let candidate = volume && previousSeat >= 0 && previousSeat + 1 < params.seats ? previousSeat + 1 : seatRng.nextInt(params.seats);
      if (!available(candidate, t)) {
        let found = -1;
        for (let tries = 0; tries < 4; tries += 1) {
          const next = seatRng.nextInt(params.seats);
          if (available(next, t)) {
            found = next;
            break;
          }
        }
        if (found < 0) {
          push(t, session, EVENT_KIND.HOLD_TRY, {
            seat: candidate,
            result: RESULT.CONFLICT,
            retry: attempt,
            latency: Math.max(1, roundPositive(sampleExponential(valueRng) * (bot ? 15 : 60))),
            firstHold: firstHold[session],
          });
          continue;
        }
        candidate = found;
      }

      const limit = attempt >= 4;
      const error = !limit && valueRng.nextUnit() < (bot ? 0.005 : 0.02);
      const result = limit ? RESULT.LIMIT : error ? RESULT.ERROR : RESULT.HELD;
      push(t, session, EVENT_KIND.HOLD_TRY, {
        seat: candidate,
        result,
        retry: attempt,
        latency: Math.max(1, Math.min(3_000, roundPositive(sampleExponential(valueRng) * (bot ? 15 : 60)))),
        firstHold: firstHold[session],
      });
      if (result !== RESULT.HELD) continue;

      previousSeat = candidate;
      const outcome = valueRng.nextUnit();
      const sale = outcome < 0.82;
      const payFail = !sale && outcome < 0.92;
      const holdEndAt =
        sale || payFail
          ? t + 500 + valueRng.nextInt(1_500)
          : t + 30_000 + valueRng.nextInt(90_000);

      if (sale) {
        const payAt = holdEndAt + 300 + valueRng.nextInt(700);
        push(payAt, session, EVENT_KIND.PAY_TRY, {
          seat: candidate,
          latency: Math.max(1, roundPositive(sampleExponential(valueRng) * (bot ? 12 : 50))),
        });
        const saleAt = payAt + 800 + valueRng.nextInt(3_000);
        push(saleAt, session, EVENT_KIND.SALE, { seat: candidate, result: RESULT.PAID });
        if (saleAt <= windowMs) {
          sold[candidate] = 1;
          freeAt[candidate] = Number.POSITIVE_INFINITY;
        } else {
          freeAt[candidate] = Number.POSITIVE_INFINITY;
        }
      } else if (payFail) {
        const payAt = holdEndAt + 300 + valueRng.nextInt(700);
        push(payAt, session, EVENT_KIND.PAY_TRY, {
          seat: candidate,
          latency: Math.max(1, roundPositive(sampleExponential(valueRng) * (bot ? 12 : 50))),
        });
        const failAt = payAt + 500 + valueRng.nextInt(2_000);
        push(failAt, session, EVENT_KIND.PAY_FAIL, { seat: candidate, result: RESULT.FAILED });
        freeAt[candidate] = failAt <= windowMs ? failAt : Number.POSITIVE_INFINITY;
      } else {
        push(holdEndAt, session, EVENT_KIND.HOLD_END, { seat: candidate });
        freeAt[candidate] = holdEndAt <= windowMs ? holdEndAt : Number.POSITIVE_INFINITY;
      }
    }
  }

  drafts.sort((a, b) => a.t - b.t || a.seq - b.seq);
  const columns = makeColumns(drafts.length);
  const truthState = new Uint8Array(params.seats);
  const transitions: SeatTransition[] = [];
  for (let i = 0; i < drafts.length; i += 1) {
    const draft = drafts[i];
    columns.t_ms[i] = draft.t;
    columns.kind[i] = draft.kind;
    columns.seat[i] = draft.seat;
    columns.section[i] = draft.section;
    columns.session[i] = draft.session;
    columns.result[i] = draft.result;
    columns.retry[i] = draft.retry;
    columns.latency_ms[i] = draft.latency;
    columns.first_hold_ms[i] = draft.firstHold;
    columns.entropy[i] = draft.entropy;
    columns.net_type[i] = draft.netType;
    columns.asn[i] = draft.asn;
    columns.device_group[i] = draft.deviceGroup;
    columns.bot_tier[i] = draft.botTier;
    columns.member[i] = 0;
    columns.post_seat[i] = 0;
    applyTruth(truthState, transitions, draft);
  }

  const sessions: SessionTruth[] = new Array(sessionCount);
  for (let i = 0; i < sessionCount; i += 1) {
    sessions[i] = {
      session: i,
      isBot: isBot[i] === 1,
      botClass: botClass[i],
      botTier: botTier[i],
      entropy: entropy[i],
      firstHoldMs: admitAt[i] >= 0 ? firstHold[i] : null,
      deviceGroup: deviceGroup[i],
      netType: netType[i],
      asn: asn[i],
      queueEnterMs: queueEnter[i],
      admitMs: admitAt[i] >= 0 ? admitAt[i] : null,
    };
  }

  return {
    meta: {
      schema: SCHEMA_NAME,
      source: 'SYNTHETIC',
      seatCount: params.seats,
      sectionCount: params.sectionCount,
      saleStart: SALE_START_ISO,
      seed: params.seed,
      generatorVersion: params.generatorVersion,
      windowToMs: windowMs,
    },
    columns,
    truth: { seatCount: params.seats, sessions, transitions },
    stats: { eventCount: drafts.length, sessionCount, admittedCount, botCount },
  };
}

/** 생성기 정답: 각 좌석의 마지막 상태 변화만 적용한다. 체크포인트 구현과 별개다. */
export function seatStateAt(truth: ScenarioTruth, tMs: number): Uint8Array {
  const state = new Uint8Array(truth.seatCount);
  for (const transition of truth.transitions) {
    if (transition.tMs > tMs) break;
    state[transition.seat] = transition.state;
  }
  return state;
}

export function shareSearch(params: ScenarioParams): string {
  const query = new URLSearchParams();
  query.set('scenario', params.preset);
  query.set('seed', params.seed);
  query.set('v', String(params.generatorVersion));
  query.set('seats', String(params.seats));
  query.set('sections', String(params.sectionCount));
  query.set('queue', String(params.queueSize));
  query.set('window', String(roundPositive(params.windowMs / 1_000)));
  query.set('bots', String(roundPositive(params.botRatio * 100)));
  query.set('order', params.ordering);
  query.set('layout', params.layout);
  query.set('mimic', params.mimicBots ? '1' : '0');
  return `?${query.toString()}`;
}

export type ShareParse = { ok: true; params: ScenarioParams } | { ok: false; code: 'version' | 'preset' | 'seed' | 'params'; message: string };

export function parseShareSearch(search: string | URLSearchParams): ShareParse {
  const query = typeof search === 'string' ? new URLSearchParams(search) : search;
  const presetRaw = query.get('scenario');
  const preset = presetRaw === null ? 'concert' : presetRaw;
  if (!Object.prototype.hasOwnProperty.call(PRESETS, preset)) return { ok: false, code: 'preset', message: '모르는 프리셋입니다' };

  const versionRaw = query.get('v');
  const version = versionRaw === null ? DEFAULT_GENERATOR_VERSION : Number(versionRaw);
  if (!Number.isInteger(version) || version !== DEFAULT_GENERATOR_VERSION) {
    return { ok: false, code: 'version', message: '생성기 판이 다릅니다' };
  }

  const seed = query.get('seed') ?? DEFAULT_SEED;
  if (!SEED_PATTERN.test(seed)) return { ok: false, code: 'seed', message: '시드가 허용 목록 밖입니다' };

  const defaults = defaultParams(preset as PresetId, seed);
  const readInt = (name: string, fallback: number): number | null => {
    const raw = query.get(name);
    if (raw === null) return fallback;
    if (!/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
  };

  const seats = readInt('seats', defaults.seats);
  const sections = readInt('sections', defaults.sectionCount);
  const queue = readInt('queue', defaults.queueSize);
  const windowSeconds = readInt('window', roundPositive(defaults.windowMs / 1_000));
  const bots = readInt('bots', roundPositive(defaults.botRatio * 100));
  if (seats === null || sections === null || queue === null || windowSeconds === null || bots === null || bots < 0 || bots > 60) {
    return { ok: false, code: 'params', message: '숫자 매개변수가 범위를 벗어났습니다' };
  }

  const ordering = query.get('order') ?? defaults.ordering;
  const layout = query.get('layout') ?? defaults.layout;
  const mimicRaw = query.get('mimic');
  const mimic = mimicRaw === null ? defaults.mimicBots : mimicRaw === '1';
  if (mimicRaw !== null && mimicRaw !== '0' && mimicRaw !== '1') return { ok: false, code: 'params', message: '사람 흉내 값이 0·1이 아닙니다' };
  if (ordering !== 'fifo' && ordering !== 'hybrid') return { ok: false, code: 'params', message: '정렬 방식이 다릅니다' };
  if (layout !== 'arena' && layout !== 'circular') return { ok: false, code: 'params', message: '배치가 다릅니다' };

  const params: ScenarioParams = {
    preset: preset as PresetId,
    seed,
    generatorVersion: version,
    seats,
    sectionCount: sections,
    queueSize: queue,
    windowMs: windowSeconds * 1_000,
    botRatio: bots / 100,
    ordering,
    layout,
    mimicBots: mimic,
  };
  const check = validateParams(params);
  if (!check.ok) return { ok: false, code: check.field === 'seed' ? 'seed' : 'params', message: check.message };
  return { ok: true, params };
}
