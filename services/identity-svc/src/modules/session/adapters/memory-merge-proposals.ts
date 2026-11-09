// 병합 제안 저장소의 메모리 대역(시험·로컬, identity §2.1 '계정 병합의 첫 구현'). 수명은 주입한 시계로 센다.
import type { Clock } from '@peaket/platform';
import type { StoredMergeProposal } from '../domain/merge.js';
import { LinkStoreUnavailable, type MergeProposals } from '../domain/ports.js';

export class MemoryMergeProposals implements MergeProposals {
  readonly #m = new Map<string, StoredMergeProposal>();

  constructor(
    private readonly clock: Clock,
    private readonly o: { down?: boolean } = {},
  ) {}

  #up(): void {
    if (this.o.down) throw new LinkStoreUnavailable(new Error('주입한 장애'));
  }

  async save(p: StoredMergeProposal): Promise<void> {
    this.#up();
    this.#m.set(p.id, structuredClone(p));
  }

  async get(id: string): Promise<StoredMergeProposal | null> {
    this.#up();
    const p = this.#m.get(id);
    if (!p) return null;
    if (p.expiresAt <= this.clock.now()) {
      this.#m.delete(id);
      return null;
    }
    return structuredClone(p);
  }

  async remove(id: string): Promise<void> {
    this.#up();
    this.#m.delete(id);
  }
}
