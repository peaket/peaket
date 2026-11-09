// 묶음 결과 게시(명세 specs/queue.qnt의 publishBatch, docs/features/queue-admission.md §3 '묶음의 첫 구현', ADR-0041·0050 결정 7·0058).
// 닫힌 묶음의 참가자(토큰 해시 오름차순)로 머클 루트를 만들고, 묶음의 시드와 공시한 비콘으로 섞어 번호 = 첫 번호 + 순위를 준다.
// 사람별 결과와 결과 파일을 쓴 뒤 게시 표시(게시 시각·머클 루트)를 쓴다. 입력이 같으면 결과가 같아 중간에 멈춘 게시를 다시 해도 같다.
// 게시 뒤 queue-svc가 결과 키를 잃은 참가자를 보면 repair:{n}을 쓴다. 그때 다시 부르면 같은 결과를 다시 쓴다(머클 루트가 다르면 멈춘다).
// 리더(Lease, BUILD_ORDER PRF-090)가 구간이 닫히고 비콘 라운드가 나온 뒤, 그리고 다시 쓰기 표시를 보면 부른다.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { BEACON_MIN_DELAY_MS, combinedKey, commitment, drandRoundAfter, drandRoundTimeMs, EMERGENCY_BEACON, merkleRoot, shuffle, sortHashes } from '@peaket/shuffle';
import { BATCH_STORE, type BatchSchedule, type BatchStore, BEACON, type Beacon, type BeaconRound, type BeaconStopReason, type ClosedBatch, denyRunbookAuth, fixAtOf, RESULT_FILES, type ResultFiles, RUNBOOK_AUTH, type RunbookAuth, SEED_SOURCE, type SeedSource, SHUFFLE_RECORDS, type ShuffleGroup, type ShuffleRecord, type ShuffleRecords } from '../domain/ports.js';

/** 결과 파일을 고르는 토큰 해시 앞자리 수(queue-svc의 202 resultPath와 같다) */
export const RESULT_PREFIX_LEN = 3;
/** 결과 파일 수 = 16진 앞 세 자리(4,096개 [가정], ADR-0232 결정 2) */
export const RESULT_FILE_COUNT = 16 ** RESULT_PREFIX_LEN;
/** 판매 종료는 공연 시작 24시간 전, 회차 키는 그 뒤 1일 더 남긴다(docs/data.md §3) */
const DAY_MS = 24 * 3600_000;
/** 비콘 대기 상한 60초 [가정, Phase 2 2.4.1에서 확정](ADR-0050 결정 7, ADR-0231 결정 12) */
export const BEACON_WAIT_LIMIT_MS = 60_000;
export type PublishResult =
  | { status: 'PUBLISHED'; count: number; merkleRoot: string; commitment: string }
  | { status: 'REPAIRED'; count: number }
  | { status: 'ALREADY' }
  | { status: 'NOT_CLOSED' }
  | { status: 'WAITING_BEACON' }
  | { status: 'WAITING_REPLICA' }
  | { status: 'NO_SCHEDULE' }
  /** 돌던 사이에 리더를 잃어 그만뒀다(다음 리더가 다시 게시한다) */
  | { status: 'ABANDONED' }
  /** 비콘 대기 상한을 넘겼거나 공시 기록이 믿을 수 없어 멈췄다. first는 이번 호출이 멈춤을 쓴 때만 참(SEV1은 한 번만 낸다, RB-35) */
  | { status: 'BEACON_STOPPED'; reason: BeaconStopReason; first: boolean };

/** 게시 뒤 참가자가 바뀌어 같은 결과를 다시 만들 수 없다. 리더는 멈추고 알린다(사람이 결과 파일로 되살린다) */
export class BatchMembersChanged extends Error {
  constructor(eventId: string, batchNo: ShuffleGroup) {
    super(`묶음 참가자가 게시 뒤 바뀌었다(${eventId} 묶음 ${batchNo}): 머클 루트가 게시 때와 다르다`);
    this.name = 'BatchMembersChanged';
  }
}

interface PendingFiles {
  /** 이 결과를 만든 닫힌 구간 표시와 공시 라운드. 다르면 쓰지 않는다 */
  marker: string;
  round: number;
  files: Map<string, Record<string, number>>;
  rootHex: string;
  count: number;
  commitmentHex: string;
  expireAtMs: number;
}

@Injectable()
export class PublishBatchResults {
  /** forget을 부를 때마다 오른다. 돌던 게시는 시작할 때의 값과 달라졌으면 결과를 들고 남지도, 게시 표시를 쓰지도 않는다 */
  #epoch = 0;
  /** 머클 루트를 공시할 때 읽은 참가자(오름차순)와 그 루트, 그때의 닫힌 구간 표시. 비콘을 받은 뒤 큰 묶음의 SSCAN과 해시 계산을 또 하지 않게 게시까지 둔다. 리더를 잃으면 forget으로 비운다 */
  readonly #fixed = new Map<string, { members: string[]; root: Buffer; marker: string }>();
  /** 사람별 결과까지 쓰고 결과 파일을 아직 못 쓴 게시. 객체 저장소가 멈췄을 때 다시 부르면 파일만 다시 쓴다(ADR-0232 결정 12) */
  readonly #pending = new Map<string, PendingFiles>();

  constructor(
    @Inject(BATCH_STORE) private readonly store: BatchStore,
    @Inject(SHUFFLE_RECORDS) private readonly records: ShuffleRecords,
    @Inject(SEED_SOURCE) private readonly seeds: SeedSource,
    @Inject(BEACON) private readonly beacons: Beacon,
    @Inject(RESULT_FILES) private readonly files: ResultFiles,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(RUNBOOK_AUTH) private readonly runbookAuth: RunbookAuth = denyRunbookAuth,
  ) {}

  /** group: 동시 도착 묶음(1, 기본)이나 로비('lobby'). 구간마다 시드·라운드·결과 키가 따로다(ADR-0231 결정 9) */
  async run(i: { eventId: string; group?: ShuffleGroup }): Promise<PublishResult> {
    const n = i.group ?? 1;
    const pub = await this.store.published(i.eventId, n);
    const repairAt = pub?.repairAtMs ?? null;
    if (pub !== null && repairAt === null) return { status: 'ALREADY' };
    const key = `${i.eventId}|${n}`;
    const epoch = this.#epoch;
    const closed = await this.store.closed(i.eventId, n);
    if (!closed) return { status: 'NOT_CLOSED' };
    const schedule = await this.store.scheduleOf(i.eventId);
    if (schedule === null) return { status: 'NO_SCHEDULE' };
    const startsAt = schedule.startsAtMs;
    // 참가자가 0명이면 공개할 결과가 없어 공시 기록·비콘과 상관없이 빈 게시를 한다(늦은 커밋이어도 회차 전체를 멈추지 않는다, ADR-0231 결정 12)
    if (closed.size === 0 && pub === null) return this.#publishEmpty(i.eventId, n, closed);
    const rec = await this.records.read(i.eventId, n);
    if (rec === null) return this.#stop(i.eventId, n, 'no_commit', startsAt);
    // RB-35 표시는 서명을 다시 확인한다. Redis에 쓸 수 있어도 commander 두 명의 서명 없이는 비상 셔플도 라운드 변경도 일어나지 않는다(ADR-0239 결정 15). 다시 쓰기도 같다
    if ((rec.runbookInvalid || rec.emergency || rec.recommits) && (rec.runbookInvalid === true || !this.runbookAuth.authorized(i.eventId, n, rec))) {
      this.#pending.delete(key);
      return this.#stop(i.eventId, n, 'unauthorized', startsAt);
    }
    const emergency = rec.emergency !== undefined;
    // 비상 표시가 있어도 뒤에 선 멈춤은 게시를 막는다
    if (pub === null && emergency && rec.stopped) return { status: 'BEACON_STOPPED', reason: rec.stopped.reason, first: false };
    // 다시 쓰기(이미 공개한 결과를 같은 입력으로 다시 씀)와 비상 셔플(RB-35, commander 두 명이 허가, ADR-0239 결정 11)은 라운드 검사를 하지 않는다
    if (pub === null && !emergency) {
      const blocked = await this.#check(i.eventId, n, rec, schedule);
      if (blocked) {
        this.#fixed.delete(key);
        this.#pending.delete(key);
        return blocked;
      }
    }
    const marker = `${closed.first}:${closed.size}:${closed.gen}`;
    const pending = pub === null ? this.#pending.get(key) : undefined;
    if (pending?.marker === marker && pending.round === rec.round) return this.#finish(i.eventId, n, key, pending);
    // 닫힌 구간 표시나 공시 라운드가 바뀌었으면(장애 전환, RB-35 다시 공시) 들고 있던 결과는 옛 입력의 것이다. 처음부터 다시 만든다
    if (pending) this.#pending.delete(key);
    // 머클 루트를 비콘보다 먼저 공시한다(POL-005, ADR-0232 결정 5). 복제 확인 뒤라 장애 전환으로 잃을 값이 섞이지 않는다
    let early = pub === null ? await this.store.earlyRootOf(i.eventId, n) : null;
    if (pub === null && early === null) {
      if (!(await this.store.confirmReplicated(i.eventId, n, marker))) return { status: 'WAITING_REPLICA' };
      const members = sortHashes(await this.store.members(i.eventId, n));
      if (members.length > closed.size) throw new Error(`묶음 참가자(${members.length})가 닫힌 크기(${closed.size})보다 많다(닫힘 뒤 SADD는 없어야 한다)`);
      const root = merkleRoot(members.map((h) => Buffer.from(h, 'hex')));
      early = await this.store.markRoot(i.eventId, n, root.toString('hex'), startsAt);
      if (epoch === this.#epoch) this.#fixed.set(key, { members, root, marker });
    }
    // 비콘이 나온 뒤에 쓴 루트는 '목록을 비콘 전에 고정했다'는 증거가 되지 못한다(리더가 죽었다가 라운드 뒤에 처음 돈 경우). 저장소 시각으로 견주어 멈춘다
    if (pub === null && !emergency && early !== null && early.atMs > drandRoundTimeMs(rec.round)) return this.#stop(i.eventId, n, 'late_root', startsAt);
    let beacon: BeaconRound | null;
    if (emergency) {
      // 비상 셔플은 비콘을 받지 않는다. 비콘 값 자리에 고정값을 넣어 재현 규격을 그대로 쓴다(서명은 없다)
      beacon = { value: EMERGENCY_BEACON, signature: '' };
    } else if (rec.beacon !== undefined || rec.signature !== undefined) {
      // 이미 기록한 비콘은 중계를 다시 부르지 않고 그 값을 쓴다. 이 값으로 결과를 쓰기 시작했을 수 있으므로 같은 입력을 지킨다. 서명은 공시 라운드로 다시 검증한다(ADR-0239 결정 12)
      if (rec.beacon === undefined || rec.signature === undefined || !this.beacons.verifyStored(i.eventId, n, rec.round, rec.beacon, rec.signature)) {
        this.#pending.delete(key);
        return this.#stop(i.eventId, n, 'unauthorized', startsAt);
      }
      beacon = { value: Buffer.from(rec.beacon, 'hex'), signature: rec.signature };
    } else {
      beacon = await this.beacons.round(i.eventId, n);
    }
    if (!beacon) {
      // 더 기다리기(RB-35)가 있으면 그때까지 기다린다. 직전 공개 라운드로 대신하지 않는다
      if (pub === null && this.clock.now() >= this.#limitMs(rec)) return this.#stop(i.eventId, n, 'beacon', startsAt);
      return { status: 'WAITING_BEACON' };
    }
    // 장애 전환으로 묶음 표시를 잃은 뒤 이미 공개한 결과를 새 번호로 덮어쓰지 않게, 표시까지의 쓰기가 복제됐는지 먼저 본다(ADR-0181 결정 5)
    if (!(await this.store.confirmReplicated(i.eventId, n, marker))) return { status: 'WAITING_REPLICA' };

    const held = this.#fixed.get(key);
    const fixed = held?.marker === marker ? held : undefined;
    const members = fixed?.members ?? sortHashes(await this.store.members(i.eventId, n));
    if (members.length > closed.size) throw new Error(`묶음 참가자(${members.length})가 닫힌 크기(${closed.size})보다 많다(닫힘 뒤 SADD는 없어야 한다)`);
    let seed: Buffer;
    try {
      seed = await this.seeds.seed(i.eventId, n);
    } catch (err) {
      // 비콘이 있어도 시드를 풀지 못하면(KMS 장애) 같은 상한까지 다시 하고, 넘기면 멈춰 경보를 단다(ADR-0239 결정 2). 게시한 구간의 다시 쓰기는 멈추지 않는다
      if (pub === null && this.clock.now() >= this.#limitMs(rec)) return this.#stop(i.eventId, n, 'seed_unavailable', startsAt);
      throw err;
    }
    // 리더를 잃었으면 여기서 그만둔다. 사람별 결과(같은 입력이면 같은 값)도 게시 표시도 다음 리더가 쓴다
    if (epoch !== this.#epoch) return { status: 'ABANDONED' };
    const root = fixed?.root ?? merkleRoot(members.map((h) => Buffer.from(h, 'hex')));
    const rootHex = root.toString('hex');
    if (pub !== null && pub.root !== rootHex) throw new BatchMembersChanged(i.eventId, n);
    // 공시한 루트와 다르면 약속한 목록이 아니다. 이 구간만 멈춘다(SEV1, RB-35, ADR-0232 결정 5)
    if (pub === null && early !== null && early.root !== rootHex) return this.#stop(i.eventId, n, 'members_changed', startsAt);
    const order = shuffle(members, combinedKey(seed, beacon.value, root, i.eventId));
    const entries = order.map((tokenHash, rank) => ({ tokenHash, seq: closed.first + rank }));

    // 비콘을 사람별 결과보다 먼저 기록한다: 기록이 있으면 RB-35 적용 Lua가 다시 공시·비상 셔플을 받지 않는다. 그 사이 라운드가 바뀌었으면(적용이 먼저) 쓰지 않고 그만둔다(ADR-0239 결정 12, M1)
    if (pub === null && !emergency && !(await this.records.recordBeacon(i.eventId, n, beacon.value.toString('hex'), beacon.signature, startsAt, rec.round))) return { status: 'ABANDONED' };
    const saleEnd = startsAt - DAY_MS;
    await this.store.writeResults(n, entries, closed.gen, saleEnd);
    // 장애 전환으로 SADD를 잃으면 닫힌 크기보다 참가자가 적다. 남는 자리는 아무도 갖지 않으므로 빠진 번호로 돌린다
    const orphans = Array.from({ length: closed.size - members.length }, (_, k) => closed.first + members.length + k);
    if (orphans.length > 0) await this.store.markRemoved(i.eventId, orphans, saleEnd + DAY_MS);
    // 게시 때 추가 검증 중(VERIFYING)·차단(BLOCKED)인 참가자와 주인 없는 자리(ORPHAN)의 번호를 빠진 번호로 돌린다(§7, ADR-0231 결정 3, ADR-0233). 셔플 전에 통과한 사람은 돌리지 않는다.
    // 묶음 참가자의 사전 검증 토큰 해시에는 VERIFYING이 없고 취소가 남긴 ORPHAN만 있다. 결과 키를 쓴 뒤에 읽으므로 겹친 취소와 둘 중 하나는 번호를 돌린다
    const removed = new Set(await this.store.toRemoveAmong(i.eventId, n, members));
    const seqs = entries.filter((e) => removed.has(e.tokenHash)).map((e) => e.seq);
    if (seqs.length > 0) await this.store.markRemoved(i.eventId, seqs, saleEnd + DAY_MS);
    if (pub !== null && repairAt !== null) {
      // 다시 쓰기: 결과 파일은 대기열 Redis 밖이라 그대로 두고, 게시 시각도 처음 값을 둔다
      await this.store.clearRepair(i.eventId, n, repairAt);
      return { status: 'REPAIRED', count: entries.length };
    }
    // 앞자리 4,096개를 모두 쓴다(빈 앞자리는 빈 표). 그래서 404는 언제나 '셔플 전'이다(ADR-0232 결정 3)
    const byPrefix = new Map<string, Record<string, number>>();
    for (let p = 0; p < RESULT_FILE_COUNT; p++) byPrefix.set(p.toString(16).padStart(RESULT_PREFIX_LEN, '0'), {});
    for (const e of entries) byPrefix.get(e.tokenHash.slice(0, RESULT_PREFIX_LEN))![e.tokenHash] = e.seq;
    this.#fixed.delete(key);
    // 사람별 결과를 쓰는 사이에 리더를 잃었으면 결과를 들고 남지 않는다(forget 뒤에 다시 채우지 않게)
    if (epoch !== this.#epoch) return { status: 'ABANDONED' };
    const done: PendingFiles = { marker, round: rec.round, files: byPrefix, rootHex, count: entries.length, commitmentHex: commitment(i.eventId, seed).toString('hex'), expireAtMs: startsAt };
    this.#pending.set(key, done);
    return this.#finish(i.eventId, n, key, done);
  }

  /** 리더를 잃으면 들고 있던 참가자 목록과 결과 파일을 비운다(100만 명이면 약 100MB). 새 리더는 저장소에서 다시 읽는다 */
  forget(): void {
    this.#epoch += 1;
    this.#fixed.clear();
    this.#pending.clear();
  }

  /** 사람별 결과를 쓴 뒤의 마무리: 결과 파일 → 게시 표시. 실패하면 #pending이 남아 다시 부를 때 여기부터 한다 */
  async #finish(eventId: string, n: ShuffleGroup, key: string, p: PendingFiles): Promise<PublishResult> {
    await this.files.write(eventId, n, p.files);
    await this.store.markPublished(eventId, n, this.clock.now(), p.rootHex);
    this.#pending.delete(key);
    return { status: 'PUBLISHED', count: p.count, merkleRoot: p.rootHex, commitment: p.commitmentHex };
  }

  /** 이미 멈췄거나, 공시 기록을 믿을 수 없으면(목록 고정 뒤에 쓴 커밋, 고정 시각 + 3초보다 앞선 라운드) 멈춘다 */
  async #check(eventId: string, n: ShuffleGroup, rec: ShuffleRecord, schedule: BatchSchedule): Promise<PublishResult | null> {
    if (rec.stopped) return { status: 'BEACON_STOPPED', reason: rec.stopped.reason, first: false };
    const fixAt = fixAtOf(schedule, n);
    // RB-35로 다시 공시한 라운드(서명은 앞에서 확인했다): 공시 기록의 마지막 라운드와 같고, 지금 일정의 라운드 이상이며, 다시 공시한 때와 커밋을 쓴 때 모두 아직 나오지 않은 라운드여야 한다.
    // 그러면 커밋이 목록 고정 뒤에 쓰였어도(late_commit) 비콘이 시드보다 뒤에 나오므로 시드를 골라 결과를 맞출 수 없다(ADR-0239 결정 12, M2)
    const last = rec.recommits?.at(-1);
    const roundAtMs = drandRoundTimeMs(rec.round);
    if (last && last.round === rec.round && rec.round >= drandRoundAfter(fixAt) && last.atMs + BEACON_MIN_DELAY_MS <= roundAtMs && rec.atMs + BEACON_MIN_DELAY_MS <= roundAtMs) return null;
    if (rec.atMs > fixAt) return this.#stop(eventId, n, 'late_commit', schedule.startsAtMs);
    // 앞이든 뒤든 지금 일정으로 계산한 라운드와 달라지면(오픈 시각이 커밋 뒤에 바뀜) 공시와 어긋나므로 멈춘다
    if (rec.round !== drandRoundAfter(fixAt)) return this.#stop(eventId, n, 'stale_round', schedule.startsAtMs);
    return null;
  }

  /** 비콘·시드를 기다리는 상한: 공시 라운드 + 60초(비상 셔플은 허가 + 60초)와 더 기다리기 중 늦은 쪽 */
  #limitMs(rec: ShuffleRecord): number {
    const base = (rec.emergency ? rec.emergency.atMs : drandRoundTimeMs(rec.round)) + BEACON_WAIT_LIMIT_MS;
    return Math.max(base, rec.waitUntilMs ?? 0);
  }

  /** expireAtMs: 회차 키 수명(판매 종료 + 1일 = 공연 시작) */
  async #stop(eventId: string, n: ShuffleGroup, reason: BeaconStopReason, expireAtMs: number): Promise<PublishResult> {
    this.#fixed.delete(`${eventId}|${n}`);
    const first = await this.records.stop(eventId, n, this.clock.now(), reason, expireAtMs);
    return { status: 'BEACON_STOPPED', reason, first };
  }

  /** 참가자 0명: 복제 확인 뒤 빈 결과와 게시 표시만 쓴다 */
  async #publishEmpty(eventId: string, n: ShuffleGroup, closed: ClosedBatch): Promise<PublishResult> {
    const members = await this.store.members(eventId, n);
    if (members.length > 0) throw new Error(`묶음 참가자(${members.length})가 닫힌 크기(0)보다 많다(닫힘 뒤 SADD는 없어야 한다)`);
    if (!(await this.store.confirmReplicated(eventId, n, `${closed.first}:0:${closed.gen}`))) return { status: 'WAITING_REPLICA' };
    const rootHex = merkleRoot([]).toString('hex');
    await this.files.write(eventId, n, new Map());
    await this.store.markPublished(eventId, n, this.clock.now(), rootHex);
    return { status: 'PUBLISHED', count: 0, merkleRoot: rootHex, commitment: '' };
  }
}
