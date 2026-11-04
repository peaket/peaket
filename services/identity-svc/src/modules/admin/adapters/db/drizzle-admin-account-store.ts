// 관리 계정 저장소의 PostgreSQL 구현(docs/data.md admin_account, BUILD_ORDER BOT-110).
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '@peaket/platform';
import { and, eq, ne } from 'drizzle-orm';
import type { AdminAccountRow, AdminAccountStore, AdminRole, AdminStatus } from '../../domain/ports.js';
import { adminAccount } from './schema.js';

@Injectable()
export class DrizzleAdminAccountStore implements AdminAccountStore {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  /** 시험용: 계정을 바로 만든다(초대는 BOT-150) */
  async create(i: { id: string; role: AdminRole; email: string; status?: AdminStatus; promoterId?: string | null; displayName?: string | null; now: number }): Promise<void> {
    await this.database.db.insert(adminAccount).values({
      id: i.id,
      role: i.role,
      promoterId: i.promoterId ?? null,
      status: i.status ?? 'INVITED',
      email: i.email.trim().toLowerCase(),
      displayName: i.displayName ?? null,
      createdAt: new Date(i.now),
      updatedAt: new Date(i.now),
    });
  }

  async get(id: string): Promise<AdminAccountRow | null> {
    const [r] = await this.database.db.select().from(adminAccount).where(eq(adminAccount.id, id));
    if (!r) return null;
    return {
      id: r.id,
      role: r.role as AdminRole,
      promoterId: r.promoterId,
      status: r.status as AdminStatus,
      email: r.email ?? '',
      displayName: r.displayName,
      passwordPhc: r.passwordPhc,
      breachCheckedAt: r.breachCheckedAt ? r.breachCheckedAt.getTime() : null,
    };
  }

  async setPassword(i: { id: string; phc: string; breachCheckedAt: number; now: number }): Promise<boolean> {
    const done = await this.database.db
      .update(adminAccount)
      .set({ passwordPhc: i.phc, breachCheckedAt: new Date(i.breachCheckedAt), passwordChangeRequired: false, updatedAt: new Date(i.now) })
      .where(and(eq(adminAccount.id, i.id), ne(adminAccount.status, 'REMOVED')))
      .returning({ id: adminAccount.id });
    return done.length > 0;
  }
}
