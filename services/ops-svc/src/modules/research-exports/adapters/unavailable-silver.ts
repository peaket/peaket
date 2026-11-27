// 연구 갈래 실버 원천의 닫힌 대역. 실제 ClickHouse an_forensic_reader·ArrowStream→IPC는 미실행이다.
import type { ResearchColumn } from '../domain/research-export.js';
import type { ResearchSilverSource } from '../domain/ports.js';

export class UnavailableResearchSilverSource implements ResearchSilverSource {
  async build(_i: { eventId: string; fromMs: number; toMs: number }): Promise<{
    bytes: Uint8Array;
    rowCount: number;
    columns: readonly ResearchColumn[];
  }> {
    throw new Error('research-silver-unavailable');
  }
}
