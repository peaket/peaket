// 좌석맵 판 파일에서 구역 수 읽기(docs/features/seat-hold.md §7 'realtime-gw의 첫 구현' '판 파일', ADR-0296 결정 3, BUILD_ORDER HOT-090).
// PEAKET_SEATMAP_DIR의 {eventId}.json에서 layout.layoutVersion(u32)과 layout.sections의 개수(1~65,535)만 읽고 좌석 층은 보지 않는다.
// 읽는 때와 기억은 seat-hold §2 '운영 좌석맵 판'의 '읽는 때'와 같다: 처음 붙을 때 한 번(같은 회차의 동시 요청은 한 번만 읽는다),
// 없거나 틀리면 1초 동안 '없음'을 기억하고(1,024개까지, 넘으면 가장 오래된 것부터 잊는다), 30초 [가정]마다 읽은 회차를 다시 읽고
// 실패하면 이전 판을 둔다. 판을 바꾸는 것은 판 번호(layoutVersion)가 다른 파일뿐이다(같은 판 번호의 다른 구역 수는 받지 않는다).
// 회차는 Map으로만 찾는다(ASVS v5.0.0-15.3.6). 유스케이스 층의 형을 가져오지 않는다(층 의존 방향: 어댑터는 유스케이스를 가져오지 않는다).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clock } from '@peaket/platform';

/** 좌석 Redis 키 조각 모양(purchase-svc KEY_PART와 같다). 이 모양이 아니면 파일에 닿지 않는다(경로를 벗어나는 값을 막는다) */
const KEY_PART = /^[A-Za-z0-9_-]{1,64}$/;
/** 다시 읽는 간격(ms, [가정]) */
export const LAYOUT_REFRESH_MS = 30_000;
/** 없음·틀림을 기억하는 시간(ms) */
export const LAYOUT_MISSING_TTL_MS = 1_000;
/** 없음 기억의 개수 상한 */
export const LAYOUT_MISSING_MAX = 1_024;
const U32_MAX = 0xffff_ffff;
const MAX_SECTIONS = 65_535;

export interface LayoutSections {
  layoutVersion: number;
  sectionCount: number;
}

/** 판 파일 값에서 판 번호와 구역 수. 틀리면 undefined */
export function layoutSectionsOf(raw: unknown): LayoutSections | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const layout = (raw as { layout?: unknown }).layout;
  if (layout === null || typeof layout !== 'object' || Array.isArray(layout)) return undefined;
  const { layoutVersion, sections } = layout as { layoutVersion?: unknown; sections?: unknown };
  if (typeof layoutVersion !== 'number' || !Number.isInteger(layoutVersion) || layoutVersion < 0 || layoutVersion > U32_MAX) return undefined;
  if (!Array.isArray(sections) || sections.length < 1 || sections.length > MAX_SECTIONS) return undefined;
  return { layoutVersion, sectionCount: sections.length };
}

export interface LayoutSectionsOptions {
  dir: string;
  clock: Clock;
  /** 읽지 못했을 때 warn 한 줄(회차 ID와 이유 코드만) */
  logger?: { warn(obj: object, msg: string): void };
  /** 파일 읽기(시험에서 바꿔 끼운다). 없으면 undefined, 읽지 못하면 던진다 */
  read?: (path: string) => Promise<string | undefined>;
}

const isFileMissing = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === 'ENOENT';

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (isFileMissing(err)) return undefined;
    throw err;
  }
}

/** 회차별 판 파일의 구역 수를 기억하는 곳. get은 핸드셰이크가, count는 허브(구역 색인 검사)가 부른다 */
export class LayoutSectionsFile {
  readonly #entries = new Map<string, LayoutSections>();
  /** 없음/틀림을 기억하는 회차 → 기억이 끝나는 시각(주입 Clock) */
  readonly #missing = new Map<string, number>();
  readonly #loading = new Map<string, Promise<LayoutSections | undefined>>();
  readonly #read: (path: string) => Promise<string | undefined>;

  constructor(private readonly o: LayoutSectionsOptions) {
    this.#read = o.read ?? readText;
  }

  /** 그 회차의 판(처음이면 파일을 읽는다). 없거나 틀리면 undefined */
  async get(eventId: string): Promise<LayoutSections | undefined> {
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

  /** 지금 기억한 판의 구역 수(파일을 읽지 않는다). 모르면 undefined */
  count(eventId: string): number | undefined {
    return this.#entries.get(eventId)?.sectionCount;
  }

  /** 읽은 회차를 모두 다시 읽는다. 던지지 않는다(실패하면 이전 판을 그대로 둔다) */
  async refresh(): Promise<void> {
    for (const [eventId, old] of [...this.#entries]) {
      try {
        const text = await this.#read(this.#path(eventId));
        if (text === undefined) {
          this.o.logger?.warn({ eventId, code: 'FILE_GONE' }, '좌석맵 판 파일이 사라져 이전 판을 그대로 둔다');
          continue;
        }
        const next = layoutSectionsOf(JSON.parse(text) as unknown);
        if (!next) {
          this.o.logger?.warn({ eventId, code: 'BAD_LAYOUT' }, '좌석맵 판 파일이 틀려 이전 판을 그대로 둔다');
          continue;
        }
        if (next.layoutVersion !== old.layoutVersion) this.#entries.set(eventId, next);
      } catch {
        this.o.logger?.warn({ eventId, code: 'LOAD_FAILED' }, '좌석맵 판 파일을 다시 받지 못해 이전 판을 그대로 둔다');
      }
    }
  }

  #path(eventId: string): string {
    return join(this.o.dir, `${eventId}.json`);
  }

  async #load(eventId: string): Promise<LayoutSections | undefined> {
    const remember = (): undefined => {
      this.#missing.delete(eventId);
      this.#missing.set(eventId, this.o.clock.now() + LAYOUT_MISSING_TTL_MS);
      while (this.#missing.size > LAYOUT_MISSING_MAX) {
        const oldest = this.#missing.keys().next().value;
        if (oldest === undefined) break;
        this.#missing.delete(oldest);
      }
      return undefined;
    };
    try {
      const text = await this.#read(this.#path(eventId));
      if (text === undefined) return remember();
      const entry = layoutSectionsOf(JSON.parse(text) as unknown);
      if (!entry) {
        this.o.logger?.warn({ eventId, code: 'BAD_LAYOUT' }, '좌석맵 판 파일이 틀렸다');
        return remember();
      }
      this.#entries.set(eventId, entry);
      return entry;
    } catch {
      this.o.logger?.warn({ eventId, code: 'LOAD_FAILED' }, '좌석맵 판 파일을 받지 못했다');
      return remember();
    }
  }
}
