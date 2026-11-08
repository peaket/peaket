// 시드 받기(ADR-0231 결정 6): q:{event:E}:shuffle의 봉인 시드를 풀어 커밋과 대조한 뒤 준다. 커밋과 다르면 쓰지 않는다.
import { commitment, type SeedSealer, type ShuffleGroup } from '@peaket/shuffle';
import type { SeedSource, ShuffleRecords } from '../domain/ports.js';

export class CommittedSeedSource implements SeedSource {
  constructor(
    private readonly records: ShuffleRecords,
    private readonly sealer: SeedSealer,
  ) {}

  async seed(eventId: string, group: ShuffleGroup): Promise<Buffer> {
    const rec = await this.records.read(eventId, group);
    if (!rec) throw new Error(`셔플 공시 기록이 없다(${eventId} 구간 ${group})`);
    const seed = await this.sealer.open(eventId, group, rec.sealed);
    if (commitment(eventId, seed).toString('hex') !== rec.commit) throw new Error(`봉인을 푼 시드가 커밋과 다르다(${eventId} 구간 ${group})`);
    return seed;
  }
}
