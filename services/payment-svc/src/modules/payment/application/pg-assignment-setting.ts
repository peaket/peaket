// 설정 사건 PG_ASSIGNMENT(명령 12)의 받는 쪽(ADR-0349 결정 5, docs/features/payment.md §2.2 '회차 지정(명령 12의 쓰임새)', BUILD_ORDER BAT-360 OPS-290).
// 서비스 제어 토픽 소비(startServiceControlSync, ADR-0333 결정 2)가 채우는 설정 저장소의 변경을 듣고, 종류가 PG_ASSIGNMENT인 값마다
// 회차 지정 쓰임새 AssignEventPg를 부른다. 지정 시각은 사건의 occurredAt(설정 저장소의 판 번호)이다. 키는 `<회차>:PG_ASSIGNMENT:`, 값은 asyncapi PgAssignmentValue
// {primaryPg, fallbackPg?}다. 설정 저장소는 판이 더 큰 값만 알리고, 쓰기는 표의 지정 시각보다 늦을 때만 하는 조건부 UPSERT라 다시 읽어도 같다.
// - 입력 오류·하위 결제사 규칙(pg-fallback-same-provider)에 걸리면 표를 바꾸지 않고 로그 한 줄이다(다시 하지 않는다: 같은 값은 늘 같은 답이다)
// - 저장소 오류는 1초 [가정]부터 두 배씩 30초 [가정]까지 늘려 다시 한다(제어 토픽 시작 작업의 다시 하기 간격 CONTROL_SYNC_DEFAULTS.retryMs와 같은 첫 값).
//   그사이 같은 회차의 새 사건이 오면 옛 값을 버리고 새 값을 쓴다. 회차마다 한 번에 하나씩 쓴다
// - 지우는 표시·만료(값 없음)는 지금 쓸 곳이 없어 무시한다(처음 쓰는 BAT-365가 정한다, ADR-0349 결정 5)
import type { SettingEntry } from '@peaket/platform';
import { PaymentInputError } from '../domain/confirm-command.js';
import { PgFallbackSameProviderError } from '../domain/pg-sub-provider.js';
import type { PgAssignmentSettingLog } from '../domain/ports.js';
import type { AssignEventPg, AssignEventPgInput } from './assign-event-pg.js';

/** 설정 종류(asyncapi SettingChanged.key) */
export const PG_ASSIGNMENT_SETTING_KIND = 'PG_ASSIGNMENT';
/** 저장소 오류 뒤 첫 다시 하기 간격 1초 [가정]과 상한 30초 [가정] */
export const PG_ASSIGNMENT_RETRY_MS = 1_000;
export const PG_ASSIGNMENT_RETRY_MAX_MS = 30_000;

/** 설정 저장소(플랫폼 SettingsStore)의 듣기 면 */
export interface SettingChangeSource {
  onChange(fn: (key: string, entry: SettingEntry | undefined) => void): () => void;
}

export interface PgAssignmentSettingDeps {
  readonly assign: Pick<AssignEventPg, 'execute'>;
  readonly log: PgAssignmentSettingLog;
  /** 시험이 줄인다 */
  readonly retryMs?: number;
  readonly retryMaxMs?: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 설정 값 → 쓰임새 입력. 값이 PgAssignmentValue 모양이 아니면 field가 있는 오류 표시를 돌려준다(쓰임새가 결제사 이름·회차 모양을 다시 본다)
 */
export function pgAssignmentInputOf(entry: Pick<SettingEntry, 'scope' | 'value' | 'version'>): AssignEventPgInput | { readonly invalid: string } {
  const v = entry.value;
  if (!isObject(v) || typeof v.primaryPg !== 'string') return { invalid: 'primaryPg' };
  if (v.fallbackPg !== undefined && v.fallbackPg !== null && typeof v.fallbackPg !== 'string') return { invalid: 'fallbackPg' };
  const fallback = typeof v.fallbackPg === 'string' ? v.fallbackPg : undefined;
  return { eventId: entry.scope, primary: v.primaryPg, ...(fallback === undefined ? {} : { fallback }), updatedAtMs: entry.version };
}

interface Slot {
  /** 다음에 쓸 값(쓰는 중에 온 새 사건이 덮는다) */
  next?: SettingEntry;
  running: boolean;
}

export class PgAssignmentSettingHandler {
  readonly #slots = new Map<string, Slot>();
  readonly #abort = new AbortController();
  readonly #running = new Set<Promise<void>>();
  #unsubscribe: (() => void) | undefined;

  constructor(private readonly deps: PgAssignmentSettingDeps) {}

  /** 설정 저장소의 변경을 듣기 시작한다(두 번 부르면 앞의 듣기를 끊는다) */
  subscribe(source: SettingChangeSource): void {
    this.#unsubscribe?.();
    this.#unsubscribe = source.onChange((key, entry) => this.handle(key, entry));
  }

  /** 설정 변경 하나. PG_ASSIGNMENT 종류만 본다 */
  handle(key: string, entry: SettingEntry | undefined): void {
    if (this.#abort.signal.aborted || entry === undefined || entry.kind !== PG_ASSIGNMENT_SETTING_KIND) return;
    let slot = this.#slots.get(key);
    if (!slot) {
      slot = { running: false };
      this.#slots.set(key, slot);
    }
    slot.next = entry;
    if (!slot.running) this.#start(key, slot);
  }

  #start(key: string, slot: Slot): void {
    slot.running = true;
    const run = this.#drain(slot).finally(() => {
      slot.running = false;
      this.#running.delete(run);
      // 끝나는 사이(마지막 await 뒤) 새 사건이 들어왔으면 이어서 쓴다
      if (slot.next !== undefined && !this.#abort.signal.aborted) this.#start(key, slot);
      else this.#slots.delete(key);
    });
    this.#running.add(run);
  }

  /** 듣기를 끊고 다시 하기를 멈춘 뒤, 쓰는 중인 호출을 기다린다(종료). 두 번 불러도 된다 */
  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#abort.abort();
    await Promise.allSettled([...this.#running]);
  }

  async #drain(slot: Slot): Promise<void> {
    while (slot.next !== undefined && !this.#abort.signal.aborted) {
      const entry = slot.next;
      slot.next = undefined;
      await this.#applyWithRetry(slot, entry);
    }
  }

  async #applyWithRetry(slot: Slot, entry: SettingEntry): Promise<void> {
    const input = pgAssignmentInputOf(entry);
    if ('invalid' in input) {
      this.deps.log.rejected({ eventId: entry.scope, commandId: entry.commandId, field: input.invalid });
      return;
    }
    const base = this.deps.retryMs ?? PG_ASSIGNMENT_RETRY_MS;
    const max = this.deps.retryMaxMs ?? PG_ASSIGNMENT_RETRY_MAX_MS;
    for (let attempt = 1; !this.#abort.signal.aborted; attempt++) {
      try {
        const { written } = await this.deps.assign.execute(input);
        this.deps.log.applied({ eventId: input.eventId, commandId: entry.commandId, written });
        return;
      } catch (err) {
        if (err instanceof PaymentInputError) {
          this.deps.log.rejected({ eventId: entry.scope, commandId: entry.commandId, field: err.field });
          return;
        }
        if (err instanceof PgFallbackSameProviderError) {
          this.deps.log.rejected({ eventId: input.eventId, commandId: entry.commandId, provider: err.conflict.provider, reason: err.conflict.reason });
          return;
        }
        const retryInMs = Math.min(max, base * 2 ** Math.min(attempt - 1, 30));
        this.deps.log.storeFailed({ eventId: input.eventId, commandId: entry.commandId, attempt, retryInMs, err });
        await sleep(retryInMs, this.#abort.signal);
        // 기다리는 사이 같은 회차의 새 사건이 왔으면 옛 값을 버린다(새 값이 판이 더 크다)
        if (slot.next !== undefined) return;
      }
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    t.unref?.();
    signal.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
