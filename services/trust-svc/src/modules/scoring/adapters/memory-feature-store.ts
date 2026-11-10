// 시험·로컬용 판정 피처 저장소. 운영은 redis-feature-store.ts. 지난 30일 규칙은 같게 둔다.
import { HONEYPOT_EVENTS_PER_PID } from '../domain/honeypot.js';
import { FEATURE_NAMES, type FeatureName, type FeatureRead, type FeatureStore, MIGRATION_FEATURES, type MigrationResult, type VerdictEvidence } from '../domain/ports.js';
import { DEV_SHARE_CAP } from '../domain/rules.js';
import type { DeviceHistory } from '../domain/types.js';

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;
const WINDOW_MS = WINDOW_DAYS * DAY_MS;
const dayOf = (ms: number): number => Math.floor(ms / DAY_MS);
const ASN_BUCKET_MS = 10_000;
const hostKey = (asn: number, eventId: string, bucket: number) => `${asn}:${eventId}:${bucket}`;

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
  /** 기기:회차 → pid */
  readonly #share = new Map<string, Set<string>>();
  /** ASN:회차:칸 → 진입 수 */
  readonly #hostEntries = new Map<string, number>();
  /** 시험이 부른 수를 본다 */
  readCalls = 0;
  shareCalls = 0;
  hostEntryCalls = 0;
  /** 키 회전 이음의 부른 기록과 돌려줄 결과(시험 도구). 메모리 저장소는 옛 판 키를 두지 않아 기본은 모두 none이다 */
  readonly migrateCalls: { from: string; to: string; eventId: string; until: number; now: number }[] = [];
  migrationResult: Partial<MigrationResult> = {};
  readonly #failing = new Set<FeatureName>();
  #failingAll = false;
  #failingWrites = false;

  async read(i: { deviceRef: string | undefined; pid: string; now: number; hostEntry?: { asn: number; eventId: string } | undefined; shareEventId?: string | undefined }): Promise<FeatureRead> {
    this.readCalls += 1;
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
      hostEntries: get('entries', i.hostEntry !== undefined, () => this.#bumpHost(i.hostEntry!, i.now)),
      shared: get('shared', ref !== undefined && i.pid !== '' && i.shareEventId !== undefined, () => this.#countShare(ref!, i.pid, i.shareEventId!)),
      failed,
    };
  }

  #countShare(deviceRef: string, pid: string, eventId: string): number {
    this.shareCalls += 1;
    const k = `${deviceRef}:${eventId}`;
    const set = this.#share.get(k) ?? new Set<string>();
    if (set.has(pid) || set.size >= DEV_SHARE_CAP) return set.size;
    set.add(pid);
    this.#share.set(k, set);
    return set.size;
  }

  #bumpHost(h: { asn: number; eventId: string }, now: number): number {
    this.hostEntryCalls += 1;
    const k = hostKey(h.asn, h.eventId, Math.floor(now / ASN_BUCKET_MS));
    const n = (this.#hostEntries.get(k) ?? 0) + 1;
    this.#hostEntries.set(k, n);
    return n;
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

  async migrate(i: { from: string; to: string; eventId: string; until: number; now: number }): Promise<MigrationResult> {
    this.migrateCalls.push(i);
    return Object.fromEntries(MIGRATION_FEATURES.map((f) => [f, this.migrationResult[f] ?? 'none'])) as MigrationResult;
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
    this.#share.clear();
    this.#hostEntries.clear();
    this.readCalls = 0;
    this.shareCalls = 0;
    this.hostEntryCalls = 0;
    this.migrateCalls.length = 0;
    this.migrationResult = {};
    this.#failing.clear();
    this.#failingAll = false;
    this.#failingWrites = false;
  }

  /** 회차별 기기 공유 수(시험 도구) */
  shareCount(deviceRef: string, eventId: string): number {
    return this.#share.get(`${deviceRef}:${eventId}`)?.size ?? 0;
  }

  /** 호스팅 대역의 그 시각 칸 진입 수(시험 도구) */
  hostEntries(asn: number, eventId: string, now: number): number {
    return this.#hostEntries.get(hostKey(asn, eventId, Math.floor(now / ASN_BUCKET_MS))) ?? 0;
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
