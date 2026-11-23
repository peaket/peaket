// 유스케이스: 받은 경보로 수집 대상을 고르고, 간격을 지켜 대상마다 순간 상태를 떠 진단 증거 저장소에 올린다
// (docs/observability.md §5 '진단 증거' 증거 수집기의 동작, ADR-0070 결정 1, 시험 D-T51 ①②③⑤⑥).
// - receive는 고르기·간격 판정·지표만 하고 곧바로 돌아온다(웹훅은 202로 먼저 답하고 수집은 답한 뒤에 한다)
// - 한 웹훅에서 같은 대상을 고른 경보는 한 수집에 모은다. 대상끼리는 함께 돈다
// - 올리기는 메모리의 바이트를 바로 올리고(디스크에 쓰지 않는다), 올린 뒤 그 값을 들고 있지 않는다
// - 신호(지표·로그 줄)에는 대상·결과·객체 수·바이트·걸린 시간만 싣는다. 뜬 내용·경보 설명 글·오류 글은 싣지 않는다
import type { Clock } from '@peaket/platform';
import { type AlertDecision, decideAlert, manifestAlert, type WebhookAlert } from '../domain/alert.js';
import { TargetSchedule } from '../domain/schedule.js';
import {
  errorCode,
  type EvidenceObjectStore,
  type EvidenceTarget,
  MANIFEST_FILE,
  objectKey,
  type SnapshotError,
  type SnapshotSource,
  type TargetKind,
} from '../domain/snapshot.js';

/** 대상마다 마지막 수집을 시작한 뒤 다시 뜨지 않는 간격(ms). 정본 docs/observability.md §5 '진단 증거'의 10분 [가정] */
export const EVIDENCE_TARGET_INTERVAL_MS = 10 * 60 * 1000;
/** 수집기가 쓰는 객체 이름 앞머리(서비스는 자기 접두사에만 쓴다, docs/observability.md §9 '진단 증거' 행) */
export const EVIDENCE_PREFIX = 'evidence-collector';

export type CollectionResult = 'uploaded' | 'partial' | 'failed' | 'throttled';
export const COLLECTION_RESULTS: readonly CollectionResult[] = ['uploaded', 'partial', 'failed', 'throttled'];

/** 수집 한 번을 마친 뒤의 요약(정보 로그 줄 한 줄) */
export interface CollectionSummary {
  target: string;
  kind: TargetKind;
  result: Exclude<CollectionResult, 'throttled'>;
  objects: number;
  bytes: number;
  durationMs: number;
}

/** 지표·로그로 내보내는 곳(조립에서 잇는다) */
export interface CollectorSignals {
  alert(decision: AlertDecision): void;
  collection(target: string, result: CollectionResult): void;
  collected(summary: CollectionSummary): void;
  /** 수집 안에서 예상하지 못한 오류(종류 이름만) */
  crashed(target: string, code: string): void;
}

export interface CollectEvidenceOptions {
  targets: readonly EvidenceTarget[];
  sources: Readonly<Record<TargetKind, SnapshotSource>>;
  store: EvidenceObjectStore;
  clock: Clock;
  signals: CollectorSignals;
  intervalMs?: number;
}

const JSON_TYPE = 'application/json';
const encoder = new TextEncoder();

export class CollectEvidence {
  readonly #targets: ReadonlyMap<string, EvidenceTarget>;
  readonly #names: readonly string[];
  readonly #o: CollectEvidenceOptions;
  readonly #schedule: TargetSchedule;
  readonly #inflight = new Set<Promise<void>>();

  constructor(o: CollectEvidenceOptions) {
    this.#o = o;
    this.#targets = new Map(o.targets.map((t) => [t.name, t]));
    this.#names = o.targets.map((t) => t.name);
    this.#schedule = new TargetSchedule(o.intervalMs ?? EVIDENCE_TARGET_INTERVAL_MS);
  }

  /** 웹훅 한 번의 경보들을 받는다. 받은 경보 수를 낸다. 수집은 이 함수가 돌아온 뒤에 시작한다 */
  receive(alerts: readonly WebhookAlert[]): number {
    const byTarget = new Map<string, WebhookAlert[]>();
    for (const alert of alerts) {
      const { decision, targets } = decideAlert(alert, this.#names);
      this.#o.signals.alert(decision);
      for (const name of targets) {
        const list = byTarget.get(name) ?? [];
        list.push(alert);
        byTarget.set(name, list);
      }
    }
    for (const [name, list] of byTarget) {
      const target = this.#targets.get(name)!;
      if (!this.#schedule.tryStart(name, this.#o.clock.monotonicMs())) {
        this.#o.signals.collection(name, 'throttled');
        continue;
      }
      const collectedAt = new Date(this.#o.clock.now()).toISOString();
      const run: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => this.#collect(target, list, collectedAt))
        .catch((err: unknown) => this.#o.signals.crashed(name, errorCode(err, 'collect_failed')))
        .finally(() => {
          this.#schedule.finish(name);
          this.#inflight.delete(run);
        });
      this.#inflight.add(run);
    }
    return alerts.length;
  }

  /** 지금까지 받은 웹훅의 수집이 모두 끝나면 풀린다 */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
  }

  async #collect(target: EvidenceTarget, alerts: readonly WebhookAlert[], collectedAt: string): Promise<void> {
    const startedMs = this.#o.clock.monotonicMs();
    const snapshot = await this.#o.sources[target.kind].snapshot(target);
    const files: string[] = [];
    const errors: SnapshotError[] = [...snapshot.errors];
    let bytes = 0;
    for (const f of snapshot.files) {
      try {
        await this.#o.store.putBytes(objectKey(EVIDENCE_PREFIX, target.name, collectedAt, f.name), f.body, f.contentType);
        files.push(f.name);
        bytes += f.body.byteLength;
      } catch (err) {
        errors.push({ file: f.name, code: errorCode(err, 'upload_failed') });
      }
    }
    const manifest = encoder.encode(
      JSON.stringify({ target: target.name, kind: target.kind, collectedAt, alerts: alerts.map(manifestAlert), files, errors }, null, 2),
    );
    let manifestUploaded = true;
    try {
      await this.#o.store.putBytes(objectKey(EVIDENCE_PREFIX, target.name, collectedAt, MANIFEST_FILE), manifest, JSON_TYPE);
      bytes += manifest.byteLength;
    } catch {
      manifestUploaded = false;
    }
    const result: Exclude<CollectionResult, 'throttled'> = !manifestUploaded || files.length === 0 ? 'failed' : errors.length > 0 ? 'partial' : 'uploaded';
    this.#o.signals.collection(target.name, result);
    this.#o.signals.collected({
      target: target.name,
      kind: target.kind,
      result,
      objects: files.length + (manifestUploaded ? 1 : 0),
      bytes,
      durationMs: Math.max(0, Math.round(this.#o.clock.monotonicMs() - startedMs)),
    });
  }
}
