// 묶음 결과 게시(명세 specs/queue.qnt의 publishBatch, docs/features/queue-admission.md §3 '묶음의 첫 구현', ADR-0041·0050 결정 7·0058).
// 닫힌 묶음의 참가자(토큰 해시 오름차순)로 머클 루트를 만들고, 묶음의 시드와 공시한 비콘으로 섞어 번호 = 첫 번호 + 순위를 준다.
// 사람별 결과와 결과 파일을 쓴 뒤 게시 표시(게시 시각·머클 루트)를 쓴다. 입력이 같으면 결과가 같아 중간에 멈춘 게시를 다시 해도 같다.
// 게시 뒤 queue-svc가 결과 키를 잃은 참가자를 보면 repair:{n}을 쓴다. 그때 다시 부르면 같은 결과를 다시 쓴다(머클 루트가 다르면 멈춘다).
// 리더(Lease, BUILD_ORDER PRF-090)가 구간이 닫히고 비콘 라운드가 나온 뒤, 그리고 다시 쓰기 표시를 보면 부른다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { combinedKey, commitment, merkleRoot, shuffle, sortHashes } from '@peaket/shuffle';
import { BATCH_STORE, type BatchStore, BEACON, type Beacon, RESULT_FILES, type ResultFiles, SEED_SOURCE, type SeedSource } from '../domain/ports.js';

/** 결과 파일을 고르는 토큰 해시 앞자리 수(queue-svc의 202 resultPath와 같다) */
export const RESULT_PREFIX_LEN = 3;
/** 판매 종료는 공연 시작 24시간 전, 회차 키는 그 뒤 1일 더 남긴다(docs/data.md §3) */
const DAY_MS = 24 * 3600_000;

export type PublishResult =
  | { status: 'PUBLISHED'; count: number; merkleRoot: string; commitment: string }
  | { status: 'REPAIRED'; count: number }
  | { status: 'ALREADY' }
  | { status: 'NOT_CLOSED' }
  | { status: 'WAITING_BEACON' }
  | { status: 'NO_SCHEDULE' };

/** 게시 뒤 참가자가 바뀌어 같은 결과를 다시 만들 수 없다. 리더는 멈추고 알린다(사람이 결과 파일로 되살린다) */
export class BatchMembersChanged extends Error {
  constructor(eventId: string, batchNo: number) {
    super(`묶음 참가자가 게시 뒤 바뀌었다(${eventId} 묶음 ${batchNo}): 머클 루트가 게시 때와 다르다`);
    this.name = 'BatchMembersChanged';
  }
}

@Injectable()
export class PublishBatchResults {
  constructor(
    @Inject(BATCH_STORE) private readonly store: BatchStore,
    @Inject(SEED_SOURCE) private readonly seeds: SeedSource,
    @Inject(BEACON) private readonly beacons: Beacon,
    @Inject(RESULT_FILES) private readonly files: ResultFiles,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(i: { eventId: string; batchNo?: number }): Promise<PublishResult> {
    const n = i.batchNo ?? 1;
    const pub = await this.store.published(i.eventId, n);
    const repairAt = pub?.repairAtMs ?? null;
    if (pub !== null && repairAt === null) return { status: 'ALREADY' };
    const closed = await this.store.closed(i.eventId, n);
    if (!closed) return { status: 'NOT_CLOSED' };
    const startsAt = await this.store.startsAtOf(i.eventId);
    if (startsAt === null) return { status: 'NO_SCHEDULE' };
    const beacon = await this.beacons.value(i.eventId, n);
    if (!beacon) return { status: 'WAITING_BEACON' };

    const members = sortHashes(await this.store.members(i.eventId, n));
    if (members.length > closed.size) throw new Error(`묶음 참가자(${members.length})가 닫힌 크기(${closed.size})보다 많다(닫힘 뒤 SADD는 없어야 한다)`);
    const seed = await this.seeds.seed(i.eventId, n);
    const root = merkleRoot(members.map((h) => Buffer.from(h, 'hex')));
    const rootHex = root.toString('hex');
    if (pub !== null && pub.root !== rootHex) throw new BatchMembersChanged(i.eventId, n);
    const order = shuffle(members, combinedKey(seed, beacon, root, i.eventId));
    const entries = order.map((tokenHash, rank) => ({ tokenHash, seq: closed.first + rank }));

    const saleEnd = startsAt - DAY_MS;
    await this.store.writeResults(entries, closed.gen, saleEnd);
    // 장애 전환으로 SADD를 잃으면 닫힌 크기보다 참가자가 적다. 남는 자리는 아무도 갖지 않으므로 빠진 번호로 돌린다
    const orphans = Array.from({ length: closed.size - members.length }, (_, k) => closed.first + members.length + k);
    if (orphans.length > 0) await this.store.markRemoved(i.eventId, orphans, saleEnd + DAY_MS);
    if (pub !== null && repairAt !== null) {
      // 다시 쓰기: 결과 파일은 대기열 Redis 밖이라 그대로 두고, 게시 시각도 처음 값을 둔다
      await this.store.clearRepair(i.eventId, n, repairAt);
      return { status: 'REPAIRED', count: entries.length };
    }
    const byPrefix = new Map<string, Record<string, number>>();
    for (const e of entries) {
      const p = e.tokenHash.slice(0, RESULT_PREFIX_LEN);
      const file = byPrefix.get(p) ?? {};
      file[e.tokenHash] = e.seq;
      byPrefix.set(p, file);
    }
    await this.files.write(i.eventId, n, byPrefix);
    await this.store.markPublished(i.eventId, n, this.clock.now(), rootHex);
    return { status: 'PUBLISHED', count: entries.length, merkleRoot: rootHex, commitment: commitment(i.eventId, seed).toString('hex') };
  }
}
