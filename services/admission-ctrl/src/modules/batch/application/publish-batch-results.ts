// 묶음 결과 게시(명세 specs/queue.qnt의 publishBatch, docs/features/queue-admission.md §3 '묶음의 첫 구현', ADR-0041·0050 결정 7·0058).
// 닫힌 묶음의 참가자(토큰 해시 오름차순)로 머클 루트를 만들고, 묶음의 시드와 공시한 비콘으로 섞어 번호 = 첫 번호 + 순위를 준다.
// 사람별 결과와 결과 파일을 쓴 뒤 게시 표시(게시 시각·머클 루트)를 쓴다. 입력이 같으면 결과가 같아 중간에 멈춘 게시를 다시 해도 같다.
// 게시 뒤 queue-svc가 결과 키를 잃은 참가자를 보면 repair:{n}을 쓴다. 그때 다시 부르면 같은 결과를 다시 쓴다(머클 루트가 다르면 멈춘다).
// 리더(Lease, BUILD_ORDER PRF-090)가 구간이 닫히고 비콘 라운드가 나온 뒤, 그리고 다시 쓰기 표시를 보면 부른다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { combinedKey, commitment, drandRoundAfter, drandRoundTimeMs, merkleRoot, shuffle, sortHashes } from '@peaket/shuffle';
import { BATCH_STORE, type BatchSchedule, type BatchStore, BEACON, type Beacon, type BeaconStopReason, type ClosedBatch, RESULT_FILES, type ResultFiles, SEED_SOURCE, type SeedSource, SHUFFLE_RECORDS, type ShuffleGroup, type ShuffleRecord, type ShuffleRecords } from '../domain/ports.js';

/** 결과 파일을 고르는 토큰 해시 앞자리 수(queue-svc의 202 resultPath와 같다) */
export const RESULT_PREFIX_LEN = 3;
/** 결과 파일 수 = 16진 앞 세 자리(4,096개 [가정], ADR-0232 결정 2) */
export const RESULT_FILE_COUNT = 16 ** RESULT_PREFIX_LEN;
/** 판매 종료는 공연 시작 24시간 전, 회차 키는 그 뒤 1일 더 남긴다(docs/data.md §3) */
const DAY_MS = 24 * 3600_000;
/** 비콘 대기 상한 60초 [가정, Phase 2 2.4.1에서 확정](ADR-0050 결정 7, ADR-0231 결정 12) */
export const BEACON_WAIT_LIMIT_MS = 60_000;
/** 묶음 구간 길이의 처음 값(리더와 같다) */
const BATCH_WINDOW_DEFAULT_MS = 2_000;

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
  /** 이 결과를 만든 닫힌 구간 표시. 다르면 쓰지 않는다 */
  marker: string;
  files: Map<string, Record<string, number>>;
  rootHex: string;
  beaconHex: string;
  signature: string;
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
    // 다시 쓰기(이미 공개한 결과를 같은 입력으로 다시 씀)는 멈춤·라운드 검사를 하지 않는다
    if (pub === null) {
      const blocked = await this.#check(i.eventId, n, rec, schedule);
      if (blocked) {
        this.#fixed.delete(key);
        this.#pending.delete(key);
        return blocked;
      }
    }
    const marker = `${closed.first}:${closed.size}:${closed.gen}`;
    const pending = pub === null ? this.#pending.get(key) : undefined;
    if (pending?.marker === marker) return this.#finish(i.eventId, n, key, pending);
    // 닫힌 구간 표시가 바뀌었으면(장애 전환 등) 들고 있던 결과는 옛 구간의 것이다. 처음부터 다시 만든다
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
    if (pub === null && early !== null && early.atMs > drandRoundTimeMs(rec.round)) return this.#stop(i.eventId, n, 'late_root', startsAt);
    const beacon = await this.beacons.round(i.eventId, n);
    if (!beacon) {
      if (pub === null && this.clock.now() >= drandRoundTimeMs(rec.round) + BEACON_WAIT_LIMIT_MS) return this.#stop(i.eventId, n, 'beacon', startsAt);
      return { status: 'WAITING_BEACON' };
    }
    // 장애 전환으로 묶음 표시를 잃은 뒤 이미 공개한 결과를 새 번호로 덮어쓰지 않게, 표시까지의 쓰기가 복제됐는지 먼저 본다(ADR-0181 결정 5)
    if (!(await this.store.confirmReplicated(i.eventId, n, marker))) return { status: 'WAITING_REPLICA' };

    const held = this.#fixed.get(key);
    const fixed = held?.marker === marker ? held : undefined;
    const members = fixed?.members ?? sortHashes(await this.store.members(i.eventId, n));
    if (members.length > closed.size) throw new Error(`묶음 참가자(${members.length})가 닫힌 크기(${closed.size})보다 많다(닫힘 뒤 SADD는 없어야 한다)`);
    const seed = await this.seeds.seed(i.eventId, n);
    // 리더를 잃었으면 여기서 그만둔다. 사람별 결과(같은 입력이면 같은 값)도 게시 표시도 다음 리더가 쓴다
    if (epoch !== this.#epoch) return { status: 'ABANDONED' };
    const root = fixed?.root ?? merkleRoot(members.map((h) => Buffer.from(h, 'hex')));
    const rootHex = root.toString('hex');
    if (pub !== null && pub.root !== rootHex) throw new BatchMembersChanged(i.eventId, n);
    // 공시한 루트와 다르면 약속한 목록이 아니다. 이 구간만 멈춘다(SEV1, RB-35, ADR-0232 결정 5)
    if (pub === null && early !== null && early.root !== rootHex) return this.#stop(i.eventId, n, 'members_changed', startsAt);
    const order = shuffle(members, combinedKey(seed, beacon.value, root, i.eventId));
    const entries = order.map((tokenHash, rank) => ({ tokenHash, seq: closed.first + rank }));

    const saleEnd = startsAt - DAY_MS;
    await this.store.writeResults(n, entries, closed.gen, saleEnd);
    // 장애 전환으로 SADD를 잃으면 닫힌 크기보다 참가자가 적다. 남는 자리는 아무도 갖지 않으므로 빠진 번호로 돌린다
    const orphans = Array.from({ length: closed.size - members.length }, (_, k) => closed.first + members.length + k);
    if (orphans.length > 0) await this.store.markRemoved(i.eventId, orphans, saleEnd + DAY_MS);
    // 로비는 게시 때 추가 검증 중(VERIFYING)인 참가자와 주인 없는 자리(ORPHAN)의 번호를 빠진 번호로 돌린다(§7, ADR-0231 결정 3). 셔플 전에 통과한 사람은 돌리지 않는다
    if (n === 'lobby') {
      const removed = new Set(await this.store.toRemoveAmong(i.eventId, members));
      const seqs = entries.filter((e) => removed.has(e.tokenHash)).map((e) => e.seq);
      if (seqs.length > 0) await this.store.markRemoved(i.eventId, seqs, saleEnd + DAY_MS);
    }
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
    const done: PendingFiles = { marker, files: byPrefix, rootHex, beaconHex: beacon.value.toString('hex'), signature: beacon.signature, count: entries.length, commitmentHex: commitment(i.eventId, seed).toString('hex'), expireAtMs: startsAt };
    this.#pending.set(key, done);
    return this.#finish(i.eventId, n, key, done);
  }

  /** 리더를 잃으면 들고 있던 참가자 목록과 결과 파일을 비운다(100만 명이면 약 100MB). 새 리더는 저장소에서 다시 읽는다 */
  forget(): void {
    this.#epoch += 1;
    this.#fixed.clear();
    this.#pending.clear();
  }

  /** 사람별 결과를 쓴 뒤의 마무리: 비콘 기록 → 결과 파일 → 게시 표시. 실패하면 #pending이 남아 다시 부를 때 여기부터 한다 */
  async #finish(eventId: string, n: ShuffleGroup, key: string, p: PendingFiles): Promise<PublishResult> {
    await this.records.recordBeacon(eventId, n, p.beaconHex, p.signature, p.expireAtMs);
    await this.files.write(eventId, n, p.files);
    await this.store.markPublished(eventId, n, this.clock.now(), p.rootHex);
    this.#pending.delete(key);
    return { status: 'PUBLISHED', count: p.count, merkleRoot: p.rootHex, commitment: p.commitmentHex };
  }

  /** 이미 멈췄거나, 공시 기록을 믿을 수 없으면(목록 고정 뒤에 쓴 커밋, 고정 시각 + 3초보다 앞선 라운드) 멈춘다 */
  async #check(eventId: string, n: ShuffleGroup, rec: ShuffleRecord, schedule: BatchSchedule): Promise<PublishResult | null> {
    if (rec.stopped) return { status: 'BEACON_STOPPED', reason: rec.stopped.reason, first: false };
    const fixAt = n === 'lobby' ? schedule.opensAtMs : schedule.opensAtMs + (schedule.batchWindowMs ?? BATCH_WINDOW_DEFAULT_MS);
    if (rec.atMs > fixAt) return this.#stop(eventId, n, 'late_commit', schedule.startsAtMs);
    // 앞이든 뒤든 지금 일정으로 계산한 라운드와 달라지면(오픈 시각이 커밋 뒤에 바뀜) 공시와 어긋나므로 멈춘다
    if (rec.round !== drandRoundAfter(fixAt)) return this.#stop(eventId, n, 'stale_round', schedule.startsAtMs);
    return null;
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
