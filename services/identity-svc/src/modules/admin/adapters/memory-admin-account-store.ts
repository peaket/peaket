// 관리 계정 저장소의 메모리 구현(시험·로컬, BUILD_ORDER BOT-110). 계정을 만드는 길(초대)은 BOT-150이라 시험은 create로 바로 만든다.
import type { AdminAccountRow, AdminAccountStore, AdminRole, AdminStatus } from '../domain/ports.js';

export class MemoryAdminAccountStore implements AdminAccountStore {
  readonly #rows = new Map<string, AdminAccountRow & { updatedAt: number }>();

  /** 시험용: 계정을 만든다(이메일은 소문자·앞뒤 빈칸 제거, 삭제하지 않은 계정 사이에서 하나) */
  create(i: { id: string; role: AdminRole; email: string; status?: AdminStatus; promoterId?: string | null; displayName?: string | null; now: number }): void {
    const email = i.email.trim().toLowerCase();
    if ([...this.#rows.values()].some((r) => r.status !== 'REMOVED' && r.email === email)) throw new Error('같은 업무 이메일의 계정이 있다');
    this.#rows.set(i.id, { id: i.id, role: i.role, promoterId: i.promoterId ?? null, status: i.status ?? 'INVITED', email, displayName: i.displayName ?? null, passwordPhc: null, breachCheckedAt: null, updatedAt: i.now });
  }

  /** 시험용: 삭제 상태로 바꾼다(삭제 경로는 BOT-150) */
  remove(id: string): void {
    const r = this.#rows.get(id);
    if (r) this.#rows.set(id, { ...r, status: 'REMOVED' });
  }

  /** 시험용: 한 행을 그대로 본다 */
  peek(id: string): (AdminAccountRow & { updatedAt: number }) | undefined {
    const r = this.#rows.get(id);
    return r && { ...r };
  }

  async get(id: string): Promise<AdminAccountRow | null> {
    const r = this.#rows.get(id);
    if (!r) return null;
    const { updatedAt: _u, ...row } = r;
    return row;
  }

  async setPassword(i: { id: string; phc: string; breachCheckedAt: number; now: number }): Promise<boolean> {
    const r = this.#rows.get(i.id);
    if (!r || r.status === 'REMOVED') return false;
    this.#rows.set(i.id, { ...r, passwordPhc: i.phc, breachCheckedAt: i.breachCheckedAt, updatedAt: i.now });
    return true;
  }
}
