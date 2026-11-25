// 사전 모의 센 값을 받는 쪽의 읽기 전용 PreviewControl로 채우는 ops 어댑터(F-02-5 OPS-300, ADR-0365 결정 11·16, C-T6 ①).
// 명령 1은 admission-ctrl 리더, 명령 3은 purchase-svc(세션·결제·5분 홀드·접수)와 queue-svc(대기 인원)에 묻는다.
// 대상 주소는 ControlTargets가 준 것만 쓰고, 받은 키·값은 요청 범위와 유한한 0 이상인지 다시 본다.
import type { ControlTargets } from '../domain/ports.js';
import type { CommandType } from '../domain/command.js';
import { DRY_RUN_KEYS, type DryRunCount, type DryRunCountResult, type DryRunSource, type DryRunTarget, type DryRunUnavailable } from '../domain/dry-run.js';
import type { ControlTransport } from '../domain/ports.js';

export const PREVIEW_TIMEOUT_MS = 1_000;
const PREVIEW_MAX_KEYS = 16;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ADMISSION_KEYS = DRY_RUN_KEYS.ADMISSION_TARGET ?? [];
const PURCHASE_KEYS = ['purchaseSessions', 'paymentSessions', 'holdsPerSecond5m', 'paymentAcceptsPerSecond5m'] as const;
const QUEUE_KEYS = ['waiting'] as const;

type PreviewResponse = Awaited<ReturnType<NonNullable<ControlTransport['preview']>>>;

interface Requested {
  readonly service: string;
  readonly kind: string;
  readonly scope: string;
  readonly keys: readonly string[];
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** 약속 하나에 시간 한도를 건다(transport.preview에는 취소 손잡이가 없다) */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('preview-timeout'), { name: 'TimeoutError' })), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class ControlPreviewDryRunSource implements DryRunSource {
  readonly #targets: ControlTargets;
  readonly #transport: ControlTransport;
  readonly #timeoutMs: number;
  constructor(o: { readonly targets: ControlTargets; readonly transport: ControlTransport; readonly timeoutMs?: number }) {
    this.#targets = o.targets;
    this.#transport = o.transport;
    this.#timeoutMs = o.timeoutMs ?? PREVIEW_TIMEOUT_MS;
  }

  async count(target: DryRunTarget, keys: readonly string[], _nowMs: number): Promise<DryRunCountResult> {
    if (keys.length > PREVIEW_MAX_KEYS) {
      return { counted: [], unavailable: keys.map((key) => ({ key, source: 'preview', reason: 'too-many' })) };
    }
    if (target.type === 'BLOCK_ASN_IP') {
      return { counted: [], unavailable: keys.map((key) => ({ key, source: 'preview', reason: 'source-not-wired' })) };
    }
    if (target.type === 'ADMISSION_TARGET') {
      const scope = String(target.eventId ?? target.params.eventId ?? '').toLowerCase();
      if (!LOWER_UUID.test(scope)) return invalidScope(keys);
      return this.#one('admission-ctrl', 'CONTROL_KIND_ADMISSION_TARGET', scope, keys);
    }
    if (target.type === 'KILL_SWITCH') {
      if (target.params.scope === 'PLATFORM') {
        return { counted: [], unavailable: keys.map((key) => ({ key, source: 'preview', reason: 'platform-scope-not-counted' })) };
      }
      const raw = Array.isArray(target.params.eventIds) ? (target.params.eventIds as unknown[]).map((x) => String(x).toLowerCase()) : [];
      const scopes = [...new Set(raw)];
      if (scopes.length === 0 || scopes.some((s) => !LOWER_UUID.test(s))) return invalidScope(keys);
      return this.#many(scopes, keys);
    }
    return { counted: [], unavailable: keys.map((key) => ({ key, source: 'preview', reason: 'no-source' })) };
  }

  /** 서비스 하나·회차 하나(또는 리더 하나)에 묻는다 */
  async #one(service: string, kind: string, scope: string, keys: readonly string[]): Promise<DryRunCountResult> {
    const wanted = [...keys];
    if (wanted.length === 0) return { counted: [], unavailable: [] };
    const answer = await this.#call({ service, kind, scope, keys: wanted });
    if ('reason' in answer) {
      return { counted: [], unavailable: wanted.map((key) => ({ key, source: 'preview', reason: answer.reason })) };
    }
    return { counted: answer.counted, unavailable: answer.unavailable };
  }

  /** 명령 3: 회차마다 purchase-svc·queue-svc에 묻고 키마다 더한다(한 회차라도 실패하면 그 서비스 키는 합 없이 unavailable) */
  async #many(scopes: readonly string[], keys: readonly string[]): Promise<DryRunCountResult> {
    const purchase = keys.filter((k) => (PURCHASE_KEYS as readonly string[]).includes(k));
    const queue = keys.filter((k) => (QUEUE_KEYS as readonly string[]).includes(k));
    const [p, q] = await Promise.all([
      this.#sumAcross('purchase-svc', 'CONTROL_KIND_SALE_PAUSE', scopes, purchase),
      this.#sumAcross('queue-svc', 'CONTROL_KIND_SALE_PAUSE', scopes, queue),
    ]);
    return {
      counted: [...p.counted, ...q.counted],
      unavailable: [...p.unavailable, ...q.unavailable],
    };
  }

  async #sumAcross(service: string, kind: string, scopes: readonly string[], keys: readonly string[]): Promise<DryRunCountResult> {
    if (keys.length === 0) return { counted: [], unavailable: [] };
    const answers = await Promise.all(scopes.map((scope) => this.#call({ service, kind, scope, keys })));
    const failed = answers.find((a): a is { reason: string } => 'reason' in a);
    if (failed) return { counted: [], unavailable: keys.map((key) => ({ key, source: 'preview', reason: failed.reason })) };
    const sum = new Map<string, { value: number; source: string; measuredAtMs: number }>();
    const failedKeys = new Map<string, string>();
    for (const a of answers as { counted: readonly DryRunCount[]; unavailable: readonly DryRunUnavailable[] }[]) {
      for (const key of keys) {
        const u = a.unavailable.find((x) => x.key === key);
        if (u) {
          failedKeys.set(key, u.reason);
          continue;
        }
        const c = a.counted.find((x) => x.key === key);
        if (!c) {
          failedKeys.set(key, 'unknown-key');
          continue;
        }
        const cur = sum.get(key);
        sum.set(key, { value: (cur?.value ?? 0) + c.value, source: c.source, measuredAtMs: Math.max(cur?.measuredAtMs ?? 0, Date.parse(c.measuredAt)) });
      }
    }
    return {
      counted: keys
        .filter((key) => !failedKeys.has(key))
        .map((key) => {
          const v = sum.get(key)!;
          return { key, value: v.value, source: v.source, measuredAt: iso(v.measuredAtMs) };
        }),
      unavailable: keys.filter((key) => failedKeys.has(key)).map((key) => ({ key, source: 'preview', reason: failedKeys.get(key)! })),
    };
  }

  /** 전송 한 번. 받은 키·값 검사와 실패 사유 변환을 한곳에서 한다 */
  async #call(req: Requested): Promise<{ readonly counted: readonly DryRunCount[]; readonly unavailable: readonly DryRunUnavailable[] } | { readonly reason: string }> {
    let addresses: readonly string[];
    try {
      addresses = await this.#targets.resolve(req.service);
    } catch {
      return { reason: `receiver-unavailable:${req.service}` };
    }
    const address = addresses[0];
    if (address === undefined) return { reason: `receiver-unavailable:${req.service}` };
    if (!this.#transport.preview) return { reason: `receiver-unavailable:${req.service}` };
    let res: PreviewResponse;
    try {
      res = await withTimeout(this.#transport.preview(req.service, address, { scope: req.scope, kind: req.kind, keys: req.keys }), this.#timeoutMs);
    } catch (err) {
      const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.message === 'preview-timeout');
      return { reason: `${timeout ? 'receiver-timeout' : 'receiver-unavailable'}:${req.service}` };
    }
    const counted: DryRunCount[] = [];
    const unavailable: DryRunUnavailable[] = [];
    const seen = new Set<string>();
    for (const key of req.keys) {
      const c = res.counts.find((x) => x.key === key);
      if (c) {
        seen.add(key);
        if (!Number.isFinite(c.value) || c.value < 0) unavailable.push({ key, source: 'preview', reason: 'invalid-count' });
        else if (!Number.isFinite(c.measuredAtMs)) unavailable.push({ key, source: 'preview', reason: 'invalid-count' });
        else counted.push({ key, value: c.value, source: c.source, measuredAt: iso(c.measuredAtMs) });
        continue;
      }
      const u = res.unavailable.find((x) => x.key === key);
      if (u) unavailable.push({ key, source: 'preview', reason: u.reason });
      else unavailable.push({ key, source: 'preview', reason: 'unknown-key' });
    }
    // 응답에 요청 밖 키가 섞여도 위 루프가 무시한다(seen은 지금 쓰지 않지만 뜻을 남긴다)
    void seen;
    return { counted, unavailable };
  }
}

const invalidScope = (keys: readonly string[]): DryRunCountResult => ({
  counted: [],
  unavailable: keys.map((key) => ({ key, source: 'preview', reason: 'invalid-scope' })),
});

export type { CommandType };
