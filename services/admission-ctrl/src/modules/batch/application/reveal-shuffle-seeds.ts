// 시드 공개(POL-005, ADR-0232 결정 7). 오픈 60분 뒤, 그 구간을 게시한 뒤에만 봉인을 풀어 커밋과 대조하고 q:{event:E}:shuffle에 비어 있을 때만 쓴다.
// 게시하지 못한 구간(멈춘 구간 포함)은 공개하지 않는다. RB-35 판단 전에 시드가 나가면 비상 셔플의 결과를 누구나 미리 알게 된다.
// 봉인을 푸는 일은 CommittedSeedSource가 한다(운영 KMS는 BUILD_ORDER HOT-041).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { SEED_REVEAL_AFTER_MS } from '@peaket/shuffle';
import { BATCH_STORE, type BatchStore, SEED_SOURCE, type SeedSource, SHUFFLE_RECORDS, type ShuffleGroup, type ShuffleRecords } from '../domain/ports.js';

export type RevealResult = { status: 'NOT_YET' } | { status: 'NO_RECORD' } | { status: 'STOPPED' } | { status: 'NOT_PUBLISHED' } | { status: 'ALREADY' } | { status: 'REVEALED' };

@Injectable()
export class RevealShuffleSeeds {
  constructor(
    @Inject(BATCH_STORE) private readonly store: BatchStore,
    @Inject(SHUFFLE_RECORDS) private readonly records: ShuffleRecords,
    @Inject(SEED_SOURCE) private readonly seeds: SeedSource,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** expireAtMs: 회차 키 수명(판매 종료 + 1일) */
  async run(i: { eventId: string; group: ShuffleGroup; opensAtMs: number; expireAtMs: number }): Promise<RevealResult> {
    if (this.clock.now() < i.opensAtMs + SEED_REVEAL_AFTER_MS) return { status: 'NOT_YET' };
    const rec = await this.records.read(i.eventId, i.group);
    if (!rec) return { status: 'NO_RECORD' };
    if (rec.seed) return { status: 'ALREADY' };
    if (rec.stopped) return { status: 'STOPPED' };
    if (!(await this.store.published(i.eventId, i.group))) return { status: 'NOT_PUBLISHED' };
    const seed = await this.seeds.seed(i.eventId, i.group);
    await this.records.reveal(i.eventId, i.group, seed.toString('hex'), this.clock.now(), i.expireAtMs);
    return { status: 'REVEALED' };
  }
}
