// ASN 분류표(docs/features/bot-defense.md §3.1, ASN = 인터넷 사업자·데이터센터마다 받은 네트워크 번호): ASN을 호스팅·프록시·그 밖으로 나눈다.
// trust-svc의 NetworkScore와 queue-svc의 축소 운영 IP 한도(§11.2)가 함께 읽는다. 분류표에는 판정 기준값이 없어 공개되어도 되는 값이다.
// 1시간 [가정]마다 다시 읽고, 읽지 못하면 마지막 판을 쓴다. 한 번도 읽지 못했으면 모두 '그 밖'이다(IP 한도를 걸지 않는 안전한 쪽).
import type { Clock } from './clock.js';

export type NetClass = 'HOSTING' | 'PROXY' | 'OTHER';

export interface AsnTableData {
  version: string;
  hosting: ReadonlySet<number>;
  proxy: ReadonlySet<number>;
}

/** 파일 내용을 읽는다. 값이 틀리면 던진다(오류 문구에 내용을 싣지 않는다) */
export function parseAsnTable(text: string): AsnTableData {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('ASN 분류표가 JSON이 아니다');
  }
  const o = raw as { version?: unknown; hosting?: unknown; proxy?: unknown };
  if (typeof o?.version !== 'string' || o.version === '') throw new Error('ASN 분류표의 version이 없다');
  const numbers = (v: unknown): Set<number> => {
    if (!Array.isArray(v) || !v.every((n) => Number.isSafeInteger(n) && (n as number) > 0)) throw new Error('ASN 분류표의 목록은 양의 정수 배열이어야 한다');
    return new Set(v as number[]);
  };
  return { version: o.version, hosting: numbers(o.hosting), proxy: numbers(o.proxy) };
}

export interface AsnClassifier {
  classify(asn: number): NetClass;
}

/** 분류표 다시 읽기 주기 1시간 [가정] */
const REFRESH_MS = 3_600_000;

/**
 * 주기적으로 다시 읽는 분류표. load가 undefined를 돌려주면 분류표가 없는 것이다(그 밖으로 본다).
 * 읽기 실패는 onError로 알리고 마지막 판을 그대로 둔다
 */
export class ReloadingAsnTable implements AsnClassifier {
  #data: AsnTableData | null = null;
  #timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly o: {
      load: () => Promise<string | undefined>;
      clock: Clock;
      onError?: (reason: string) => void;
      refreshMs?: number;
    },
  ) {}

  /** 한 번 읽는다. 쓸 수 있는 판이 있으면 true */
  async refresh(): Promise<boolean> {
    try {
      const text = await this.o.load();
      if (text !== undefined) this.#data = parseAsnTable(text);
    } catch (e) {
      this.o.onError?.(e instanceof Error ? e.message : '알 수 없는 오류');
    }
    return this.#data !== null;
  }

  /** 첫 읽기를 시작하고 주기 타이머를 건다(시작을 막지 않는다) */
  start(): void {
    void this.refresh();
    this.#timer = setInterval(() => void this.refresh(), this.o.refreshMs ?? REFRESH_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  /** 지금 판의 번호(없으면 null) */
  version(): string | null {
    return this.#data?.version ?? null;
  }

  classify(asn: number): NetClass {
    if (!this.#data || asn <= 0) return 'OTHER';
    if (this.#data.hosting.has(asn)) return 'HOSTING';
    if (this.#data.proxy.has(asn)) return 'PROXY';
    return 'OTHER';
  }
}
