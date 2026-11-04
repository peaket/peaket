// 가입 때 연결 제안 저장소의 메모리 대역(시험·로컬, identity §2.1). 수명은 주입한 시계로 센다.
import type { Clock } from '@peaket/platform';
import { type LinkProposals, LinkStoreUnavailable, type StoredLinkProposal } from '../domain/ports.js';
import { LINK_MAX_ATTEMPTS } from '../domain/session.js';

export class MemoryLinkProposals implements LinkProposals {
  readonly #m = new Map<string, StoredLinkProposal>();

  constructor(
    private readonly clock: Clock,
    private readonly o: { down?: boolean } = {},
  ) {}

  #up(): void {
    if (this.o.down) throw new LinkStoreUnavailable(new Error('주입한 장애'));
  }

  #live(id: string): StoredLinkProposal | null {
    const p = this.#m.get(id);
    if (!p) return null;
    if (p.expiresAt <= this.clock.now()) {
      this.#m.delete(id);
      return null;
    }
    return p;
  }

  async save(p: StoredLinkProposal): Promise<void> {
    this.#up();
    this.#m.set(p.id, { ...p });
  }

  async get(id: string): Promise<StoredLinkProposal | null> {
    this.#up();
    const p = this.#live(id);
    return p ? { ...p } : null;
  }

  async fail(id: string): Promise<number | null> {
    this.#up();
    const p = this.#live(id);
    if (!p) return null;
    p.attempts += 1;
    if (p.attempts >= LINK_MAX_ATTEMPTS) this.#m.delete(id);
    return p.attempts;
  }

  async remove(id: string): Promise<void> {
    this.#up();
    this.#m.delete(id);
  }

  /** 시험용: 남은 제안(만료 전) */
  dump(): StoredLinkProposal[] {
    return [...this.#m.keys()].map((id) => this.#live(id)).filter((p): p is StoredLinkProposal => p !== null);
  }
}
