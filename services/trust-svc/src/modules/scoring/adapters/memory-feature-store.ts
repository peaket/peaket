// 시험·로컬용 판정 피처 저장소. 운영은 redis-feature-store.ts. 지난 30일 규칙은 같게 둔다.
import { HONEYPOT_EVENTS_PER_PID } from '../domain/honeypot.js';
import { FEATURE_NAMES, type FeatureName, type FeatureRead, type FeatureStore, type VerdictEvidence } from '../domain/ports.js';
import type { DeviceHistory } from '../domain/types.js';

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;
const WINDOW_MS = WINDOW_DAYS * DAY_MS;
const dayOf = (ms: number): number => Math.floor(ms / DAY_MS);

export class MemoryFeatureStore implements FeatureStore {
  readonly #accounts = new Map<string, Map<string, number>>();
  /** 기기 → `{kind}:{day}` → 수 */
  readonly #history = new Map<string, Map<string, number>>();
  readonly #blocked = new Set<string>();
  readonly #honeypot = new Map<string, { atMs: number; eventId: string }>();
  /** pid → 회차 → 기록한 시각 */
  readonly #honeypotEvents = new Map<string, Map<string, number>>();
  readonly #evidence = new Map<string, VerdictEvidence>();
  readonly #newDevices = new Map<string, number>();
  readonly #failing = new Set<FeatureName>();
  #failingAll = false;
  #failingWrites = false;

  async read(i: { deviceRef: string | undefined; pid: string; now: number }): Promise<FeatureRead> {
    if (this.#failingAll) throw new Error('피처 저장소 오류');
    const failed: FeatureName[] = [];
    const get = <T>(name: FeatureName, asked: boolean, f: () => T): T | undefined => {
      if (!asked) return undefined;
      if (this.#failing.has(name)) {
        failed.push(name);
        return undefined;
      }
      return f();
    };
    const ref = i.deviceRef;
    return {
      accounts: get('accounts', ref !== undefined, () => this.accountCount(ref!, i.now, i.pid)),
      history: get('history', ref !== undefined, () => this.history(ref!, i.now)),
      blocked: get('block', ref !== undefined, () => this.#blocked.has(ref!)),
      honeypot: get('honeypot', i.pid !== '', () => this.#honeypot.has(i.pid)),
      failed,
    };
  }

  async addAccount(i: { deviceRef: string; pid: string; now: number; newDevicesPerDay: number }): Promise<void> {
    let set = this.#accounts.get(i.deviceRef);
    if (!set) {
      set = new Map();
      this.#accounts.set(i.deviceRef, set);
    }
    for (const [p, at] of set) if (at < i.now - WINDOW_MS) set.delete(p);
    if (!set.has(i.pid)) {
      const k = `${i.pid}:${dayOf(i.now)}`;
      const n = this.#newDevices.get(k) ?? 0;
      if (n >= i.newDevicesPerDay) return;
      this.#newDevices.set(k, n + 1);
    }
    set.set(i.pid, i.now);
  }

  async recordChallenge(i: { deviceRef: string | undefined; pid: string; eventId: string; evidence: VerdictEvidence; now: number }): Promise<void> {
    if (this.#failingWrites) throw new Error('피처 저장소 쓰기 오류');
    if (i.deviceRef) this.#bump(i.deviceRef, 'sent', i.now);
    const k = `${i.pid}:${i.eventId}`;
    if (!this.#evidence.has(k)) this.#evidence.set(k, i.evidence);
  }

  async recordVerification(i: { deviceRef: string; passed: boolean; now: number }): Promise<void> {
    if (this.#failingWrites) throw new Error('피처 저장소 쓰기 오류');
    this.#bump(i.deviceRef, i.passed ? 'passed' : 'failed', i.now);
  }

  async recordHoneypot(i: { pid: string; eventId: string; now: number }): Promise<boolean> {
    if (this.#failingWrites) throw new Error('피처 저장소 쓰기 오류');
    this.#honeypot.set(i.pid, { atMs: i.now, eventId: i.eventId });
    if (i.eventId === '') return false;
    let events = this.#honeypotEvents.get(i.pid);
    if (!events) {
      events = new Map();
      this.#honeypotEvents.set(i.pid, events);
    }
    for (const [e, at] of events) if (i.now - at >= DAY_MS) events.delete(e);
    if (events.has(i.eventId) || events.size >= HONEYPOT_EVENTS_PER_PID) return false;
    events.set(i.eventId, i.now);
    return true;
  }

  #bump(ref: string, kind: keyof DeviceHistory, now: number): void {
    let days = this.#history.get(ref);
    if (!days) {
      days = new Map();
      this.#history.set(ref, days);
    }
    const f = `${kind}:${dayOf(now)}`;
    days.set(f, (days.get(f) ?? 0) + 1);
  }

  // 시험 도구
  blockDevice(deviceRef: string): void {
    this.#blocked.add(deviceRef);
  }

  markHoneypot(pid: string): void {
    this.#honeypot.set(pid, { atMs: 0, eventId: '' });
  }

  /** 허니팟 적중 표시의 값 */
  async honeypotOf(pid: string): Promise<{ atMs: number; eventId: string } | undefined> {
    return this.#honeypot.get(pid);
  }

  /** 기록을 비운다(시험 사이) */
  clear(): void {
    this.#accounts.clear();
    this.#history.clear();
    this.#blocked.clear();
    this.#honeypot.clear();
    this.#honeypotEvents.clear();
    this.#evidence.clear();
    this.#newDevices.clear();
    this.#failing.clear();
    this.#failingAll = false;
    this.#failingWrites = false;
  }

  /** 지난 30일 사람 수(pid를 주면 그 사람을 넣어 센 값) */
  accountCount(deviceRef: string, now: number, pid = ''): number {
    const set = this.#accounts.get(deviceRef);
    let n = 0;
    let hasPid = false;
    for (const [p, at] of set ?? []) {
      if (at >= now - WINDOW_MS) {
        n += 1;
        if (p === pid) hasPid = true;
      }
    }
    return pid !== '' && !hasPid ? n + 1 : n;
  }

  history(deviceRef: string, now: number): DeviceHistory {
    const out: DeviceHistory = { sent: 0, passed: 0, failed: 0 };
    const minDay = dayOf(now) - WINDOW_DAYS + 1;
    for (const [f, v] of this.#history.get(deviceRef) ?? []) {
      const [kind, day] = f.split(':');
      if (Number(day) >= minDay) out[kind as keyof DeviceHistory] += v;
    }
    return out;
  }

  evidence(pid: string, eventId: string): VerdictEvidence | undefined {
    return this.#evidence.get(`${pid}:${eventId}`);
  }

  /** 모든 읽기 실패 */
  fail(on: boolean): void {
    this.#failingAll = on;
  }

  /** 피처 하나만 읽기 실패 */
  failFeature(name: FeatureName): void {
    this.#failing.add(name);
  }

  failWrites(on: boolean): void {
    this.#failingWrites = on;
  }

  static readonly featureNames = FEATURE_NAMES;
}
