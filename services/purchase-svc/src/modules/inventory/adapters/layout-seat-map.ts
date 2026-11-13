// 운영 좌석맵 판(BUILD_ORDER PRF-137, docs/features/seat-hold.md §2 '운영 좌석맵 판'): 회차별 판 파일을 읽어 메모리에 두는 SeatMap·SeatMapIndex·SeatMapSections.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clock } from '@peaket/platform';
import { KEY_PART, type SeatRef } from '../domain/hold.js';
import { type AutoCandidateList, type AutoCondition, autoCandidatesOf } from '../domain/auto.js';
import type { EventSeatConfig, SeatMap, SeatMapAuto, SeatMapIndex, SeatMapSections, SeatMapTiers } from '../domain/ports.js';
import type { SaleLayout } from '../domain/sale-state.js';
import { type ParsedSeatMap, parseEventSeatMapFile, SeatMapFileError, type SectionRange } from '../domain/seat-layout.js';

/** 판 파일의 출처(지금은 폴더의 {eventId}.json. 회차 설정을 core에서 받는 길은 LCH-080) */
export interface SeatMapSource {
  /** 회차의 판 파일을 읽은 값(JSON.parse 결과). 파일이 없으면 undefined. 읽지 못하면(입출력 오류·JSON 아님) 던진다 */
  load(eventId: string): Promise<unknown | undefined>;
  /**
   * 파일이 바뀌었는지 싸게 알아보는 표시(선택). 같은 표시면 refresh가 파일을 다시 읽고 해석하지 않는다(큰 파일의 JSON 해석이 이벤트 루프를 막지 않게).
   * 파일이 없으면 undefined, 읽지 못하면 던진다
   */
  stamp?(eventId: string): Promise<string | undefined>;
}

const isFileMissing = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === 'ENOENT';

/** 폴더 `dir`의 `{eventId}.json`을 읽는 출처. eventId가 KEY_PART 모양이 아니면 파일에 닿지 않고 undefined다(경로를 벗어나는 값을 막는다) */
export class FileSeatMapSource implements SeatMapSource {
  constructor(private readonly dir: string) {}

  async load(eventId: string): Promise<unknown | undefined> {
    if (!KEY_PART.test(eventId)) return undefined;
    let text: string;
    try {
      text = await readFile(join(this.dir, `${eventId}.json`), 'utf8');
    } catch (err) {
      if (isFileMissing(err)) return undefined;
      throw err;
    }
    return JSON.parse(text) as unknown;
  }

  async stamp(eventId: string): Promise<string | undefined> {
    if (!KEY_PART.test(eventId)) return undefined;
    try {
      const s = await stat(join(this.dir, `${eventId}.json`));
      return `${s.mtimeMs}:${s.size}`;
    } catch (err) {
      if (isFileMissing(err)) return undefined;
      throw err;
    }
  }

  /**
   * 폴더에 판 파일이 있는 회차 ID들(BUILD_ORDER PRF-164, 다시 만들기 반복의 회차 목록 SeatMapEventCatalog가 쓴다).
   * 폴더의 `{회차 ID}.json` 이름에서 `.json`을 뗀 값 가운데 KEY_PART 모양인 것만, 이름 오름차순(문자 코드 순)이다. 하위 폴더·다른 확장자는 뺀다.
   * 파일 내용은 읽지 않는다(판이 틀린 회차를 거르는 것은 SeatMapEventCatalog가 seatMap.config로 한다).
   * 확장자는 소문자 `.json`만 본다(load가 `{회차 ID}.json`만 읽으므로 `.JSON`은 읽히지 않는 파일이다).
   * 구현에서 정한 것: 심볼릭 링크는 가리키는 것이 보통 파일일 때만 넣는다(쿠버네티스 ConfigMap 볼륨은 파일을 `..data/` 아래를 가리키는 링크로 둔다.
   * load도 링크를 따라 읽는다). 가리키는 것을 읽지 못한 링크(끊긴 링크 등)는 뺀다
   * @throws Error 폴더를 읽지 못함(없음 ENOENT 포함)
   */
  async list(): Promise<string[]> {
    const entries = await readdir(this.dir, { withFileTypes: true });
    const ids: string[] = [];
    for (const d of entries) {
      if (!d.name.endsWith('.json')) continue;
      const id = d.name.slice(0, -'.json'.length);
      if (!KEY_PART.test(id)) continue;
      if (d.isFile()) ids.push(id);
      else if (d.isSymbolicLink()) {
        try {
          if ((await stat(join(this.dir, d.name))).isFile()) ids.push(id);
        } catch {
          // 끊긴 링크·읽지 못하는 대상은 뺀다(load도 그 회차를 읽지 못한다)
        }
      }
    }
    // 문자 코드 순(KEY_PART는 ASCII뿐이라 UTF-16 단위 비교와 같다). localeCompare는 쓰지 않는다(환경마다 차례가 다르다)
    return ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
}

export interface LayoutSeatMapOptions {
  source: SeatMapSource;
  clock: Clock;
  /** 판 파일을 받지 못했거나 읽지 못했을 때 warn 한 줄(회차 ID와 이유 코드만) */
  logger?: { warn(obj: object, msg: string): void };
  /** 파일이 없거나 틀린 회차를 '없음'으로 기억하는 시간(ms, 기본 1000) */
  missingTtlMs?: number;
}

interface Entry {
  parsed: ParsedSeatMap;
  /** 파일 표시(source.stamp). 없으면 undefined */
  stamp: string | undefined;
  /** 판 번호·1인 한도·판매 종료·등급 가격으로 만든 같은 판 표시: 같으면 좌석 표를 다시 만들지 않는다 */
  signature: string;
  /** 판매 상태 판정의 좌석표(처음 부를 때 만들어 판마다 한 번만, BUILD_ORDER PRF-144) */
  saleLayout?: SaleLayout;
  /** 자동 배정 후보(희망 조건별로 한 번 만들어 둔다, BUILD_ORDER HOT-080) */
  auto?: Map<string, AutoCandidateList>;
}

const MISSING_TTL_MS = 1000;
/** 없음 기억의 개수 상한(서로 다른 회차 ID로 계속 물어도 메모리가 늘지 않게 가장 오래된 것부터 잊는다) */
const MISSING_MAX = 1024;

/**
 * 파일 값에서 같은 판인지 가르는 표시를 싸게 뽑는다(틀린 모양이면 undefined).
 * 선택 칸 tierPrices(등급 가격, config.tierPrices, BUILD_ORDER PRF-161)와 결제 시도의 세 칸(PRF-191)도 표시에 든다: 그 칸만 바꾼 파일도 다시 해석된다(틀린 값이면 이전 판을 둔다)
 */
function signatureOf(raw: unknown): string | undefined {
  const o = raw as { perAccountLimit?: unknown; saleEndsAt?: unknown; tierPrices?: unknown; orderName?: unknown; entryOpensAt?: unknown; virtualAccountAllowed?: unknown; layout?: { layoutVersion?: unknown } } | null;
  const v = o?.layout?.layoutVersion;
  if (typeof v !== 'number' || typeof o?.perAccountLimit !== 'number' || typeof o?.saleEndsAt !== 'string') return undefined;
  // 가격 칸이 없으면 빈 글. 있으면 JSON 글 그대로(칸 차례만 바뀐 파일은 다시 해석될 뿐이다)
  const prices = o.tierPrices === undefined ? '' : JSON.stringify(o.tierPrices);
  // 결제 시도의 선택 칸 셋도 같은 방식이다(BUILD_ORDER PRF-191). 없는 칸은 null로 든다
  const checkout = JSON.stringify([o.orderName ?? null, o.entryOpensAt ?? null, o.virtualAccountAllowed ?? null, (raw as { tierNames?: unknown }).tierNames ?? null]);
  return `${v}|${o.perAccountLimit}|${o.saleEndsAt}|${prices}|${checkout}`;
}

/** 판의 판매 대상 좌석(byId, 판매 제외석 없음)을 등급별로 모은다. 등급은 등급 ID 문자 코드 순, 색인은 오름차순이다 */
function saleLayoutOf(parsed: ParsedSeatMap): SaleLayout {
  const byTier = new Map<string, number[]>();
  for (const seat of parsed.byId.values()) {
    const list = byTier.get(seat.tierId);
    if (list) list.push(seat.index);
    else byTier.set(seat.tierId, [seat.index]);
  }
  const tiers = [...byTier]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([tierId, indexes]) => ({ tierId, indexes: indexes.sort((a, b) => a - b) }));
  return { sellableSeats: parsed.byId.size, tiers };
}

/**
 * SeatMap·SeatMapIndex·SeatMapSections·SeatMapTiers의 운영 구현. 처음 부를 때만 파일을 읽고(같은 회차의 동시 요청은 한 번만 읽는다), 없음/틀림은 missingTtlMs 동안 기억한다.
 * refresh()가 읽은 회차를 다시 읽어 바꾼다(실패하면 이전 판을 그대로 둔다. 판 번호와 설정이 같으면 좌석 표를 다시 만들지 않는다).
 */
export class LayoutSeatMap implements SeatMap, SeatMapIndex, SeatMapSections, SeatMapTiers, SeatMapAuto {
  readonly #entries = new Map<string, Entry>();
  /** 없음/틀림을 기억하는 회차 → 기억이 끝나는 시각(주입 Clock) */
  readonly #missing = new Map<string, number>();
  readonly #loading = new Map<string, Promise<Entry | undefined>>();

  constructor(private readonly o: LayoutSeatMapOptions) {}

  async config(eventId: string): Promise<EventSeatConfig | undefined> {
    const e = await this.#get(eventId);
    return e ? { ...e.parsed.config } : undefined;
  }

  async resolve(eventId: string, seatIds: readonly string[]): Promise<(SeatRef | undefined)[]> {
    const e = await this.#get(eventId);
    return seatIds.map((id) => e?.parsed.byId.get(id));
  }

  async byIndex(eventId: string, indexes: readonly number[]): Promise<(SeatRef | undefined)[]> {
    const e = await this.#get(eventId);
    return indexes.map((i) => e?.parsed.byIndex.get(i));
  }

  async sections(eventId: string): Promise<readonly SectionRange[] | undefined> {
    return (await this.#get(eventId))?.parsed.sections;
  }

  async saleLayout(eventId: string): Promise<SaleLayout | undefined> {
    const e = await this.#get(eventId);
    if (!e) return undefined;
    e.saleLayout ??= saleLayoutOf(e.parsed);
    return e.saleLayout;
  }

  /**
   * 자동 배정 후보(SeatMapAuto). 판매 대상 좌석과 등급으로 domain/auto.ts의 순수 함수가 만든다.
   * 같은 희망 조건은 판마다 한 번만 만들어 둔다(판이 바뀌면 새 Entry라 저절로 버려진다).
   */
  async autoCandidates(eventId: string, condition: AutoCondition): Promise<AutoCandidateList | undefined> {
    const e = await this.#get(eventId);
    if (!e) return undefined;
    const key = `${condition.firstTierId}|${condition.secondTierId ?? ''}|${condition.count}|${condition.wheelchair ? 1 : 0}|${condition.allowSplit ? 1 : 0}`;
    const cached = e.auto?.get(key);
    if (cached) return cached;
    const layout = (e.saleLayout ??= saleLayoutOf(e.parsed));
    const tiers = new Set(layout.tiers.map((t) => t.tierId));
    const list = autoCandidatesOf([...e.parsed.byId.values()], condition, tiers);
    (e.auto ??= new Map()).set(key, list);
    return list;
  }

  /** 읽은 회차를 모두 다시 읽어 바꾼다. 던지지 않는다(실패는 로그 한 줄이고 이전 판을 그대로 둔다) */
  async refresh(): Promise<void> {
    for (const [eventId, old] of [...this.#entries]) {
      try {
        const stamp = await this.o.source.stamp?.(eventId);
        if (stamp !== undefined && stamp === old.stamp) continue;
        const raw = await this.o.source.load(eventId);
        if (raw === undefined) {
          // 읽은 뒤 파일이 사라졌다: 이전 판을 그대로 둔다
          this.o.logger?.warn({ eventId, code: 'FILE_GONE' }, '좌석맵 판 파일이 사라져 이전 판을 그대로 둔다');
          continue;
        }
        const signature = signatureOf(raw);
        if (signature !== undefined && signature === old.signature) {
          this.#entries.set(eventId, { ...old, stamp });
          continue;
        }
        const parsed = parseEventSeatMapFile(eventId, raw);
        this.#entries.set(eventId, { parsed, stamp, signature: signature ?? '' });
      } catch (err) {
        this.o.logger?.warn({ eventId, code: err instanceof SeatMapFileError ? err.code : 'LOAD_FAILED' }, '좌석맵 판 파일을 다시 받지 못해 이전 판을 그대로 둔다');
      }
    }
  }

  async #get(eventId: string): Promise<Entry | undefined> {
    if (typeof eventId !== 'string' || !KEY_PART.test(eventId)) return undefined;
    const known = this.#entries.get(eventId);
    if (known) return known;
    const until = this.#missing.get(eventId);
    if (until !== undefined) {
      if (this.o.clock.now() < until) return undefined;
      this.#missing.delete(eventId);
    }
    let p = this.#loading.get(eventId);
    if (!p) {
      p = this.#load(eventId).finally(() => this.#loading.delete(eventId));
      this.#loading.set(eventId, p);
    }
    return p;
  }

  async #load(eventId: string): Promise<Entry | undefined> {
    const remember = (): undefined => {
      this.#missing.delete(eventId);
      this.#missing.set(eventId, this.o.clock.now() + (this.o.missingTtlMs ?? MISSING_TTL_MS));
      while (this.#missing.size > MISSING_MAX) {
        const oldest = this.#missing.keys().next().value;
        if (oldest === undefined) break;
        this.#missing.delete(oldest);
      }
      return undefined;
    };
    try {
      const stamp = await this.o.source.stamp?.(eventId);
      const raw = await this.o.source.load(eventId);
      if (raw === undefined) return remember();
      const entry: Entry = { parsed: parseEventSeatMapFile(eventId, raw), stamp, signature: signatureOf(raw) ?? '' };
      this.#entries.set(eventId, entry);
      return entry;
    } catch (err) {
      this.o.logger?.warn({ eventId, code: err instanceof SeatMapFileError ? err.code : 'LOAD_FAILED' }, '좌석맵 판 파일을 받지 못했다');
      return remember();
    }
  }
}
