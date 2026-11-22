// 실시간 그래프가 들고 있는 양의 상한(docs/frontend.md §5.7 '그래프와 들고 있는 양', ADR-0091 결정 4, ADR-0361 결정 11).
// 한 선은 최근 900점(1초 점 15분) [가정]만 고리 버퍼(정해진 크기를 돌려 쓰며 오래된 값부터 덮어쓰는 배열)에 두고, 한 장의 선은 6개 [가정]까지다.
// 넘으면 오래된 점·먼저 들어온 선부터 버린다. 가져오는 값이 없는 순수 모듈이라 Node 내장 시험 실행기로 그대로 읽는다.

/** 한 선의 점 상한 900 [가정] */
export const SERIES_MAX_POINTS = 900;
/** 한 장의 선 상한 6 [가정] */
export const CHART_MAX_SERIES = 6;

/** 실시간 점(x는 밀리초 시각, Chart.js parsing: false 꼴) */
export interface RealtimePoint {
  x: number;
  y: number | null;
}

/** 한 선의 고리 버퍼 */
export class RingSeries {
  readonly capacity: number;
  readonly #buf: (RealtimePoint | undefined)[];
  #start = 0;
  #size = 0;

  // 매개변수 속성을 쓰지 않는다(Node 타입 지우기로 그대로 읽히게)
  constructor(capacity: number = SERIES_MAX_POINTS) {
    this.capacity = capacity;
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`점 상한은 1 이상의 정수다: ${capacity}`);
    this.#buf = new Array<RealtimePoint | undefined>(capacity);
  }

  get size(): number {
    return this.#size;
  }

  /** 점 하나를 더한다. 가득 차면 가장 오래된 점을 덮는다 */
  push(x: number, y: number | null): void {
    const at = (this.#start + this.#size) % this.capacity;
    this.#buf[at] = { x, y };
    if (this.#size < this.capacity) this.#size += 1;
    else this.#start = (this.#start + 1) % this.capacity;
  }

  /** 오래된 것부터 차례대로 */
  toArray(): RealtimePoint[] {
    const out: RealtimePoint[] = [];
    for (let i = 0; i < this.#size; i += 1) out.push(this.#buf[(this.#start + i) % this.capacity] as RealtimePoint);
    return out;
  }

  clear(): void {
    this.#buf.fill(undefined);
    this.#start = 0;
    this.#size = 0;
  }
}

/** 그래프 한 장의 선들(선마다 고리 버퍼, 선 수 상한) */
export class RingChartData {
  readonly #series = new Map<string, RingSeries>();
  readonly points: number;
  readonly maxSeries: number;

  constructor(o: { points?: number; series?: number } = {}) {
    this.points = o.points ?? SERIES_MAX_POINTS;
    this.maxSeries = o.series ?? CHART_MAX_SERIES;
    if (!Number.isInteger(this.maxSeries) || this.maxSeries < 1) throw new RangeError(`선 상한은 1 이상의 정수다: ${this.maxSeries}`);
  }

  /** 선 id에 점 하나를 더한다. 새 선이 상한을 넘기면 먼저 들어온 선을 버린다 */
  push(id: string, x: number, y: number | null): void {
    let s = this.#series.get(id);
    if (!s) {
      while (this.#series.size >= this.maxSeries) {
        const oldest = this.#series.keys().next().value as string;
        this.#series.delete(oldest);
      }
      s = new RingSeries(this.points);
      this.#series.set(id, s);
    }
    s.push(x, y);
  }

  /** 선 id 차례(들어온 차례) */
  ids(): string[] {
    return [...this.#series.keys()];
  }

  /** 선 하나의 점(오래된 것부터). 없으면 빈 배열 */
  pointsOf(id: string): RealtimePoint[] {
    return this.#series.get(id)?.toArray() ?? [];
  }

  /** 모든 선의 점 수 합 */
  get totalPoints(): number {
    let n = 0;
    for (const s of this.#series.values()) n += s.size;
    return n;
  }
}
