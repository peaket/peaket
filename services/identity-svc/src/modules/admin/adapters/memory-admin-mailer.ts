// 관리 계정 메일 대역(시험, BUILD_ORDER BOT-121). 보낸 메일을 모으고, failNext면 다음 한 번을 실패로 한다.
import type { AdminMailer, AdminMailKind } from '../domain/ports.js';

export class MemoryAdminMailer implements AdminMailer {
  readonly sent: { to: string; kind: AdminMailKind; link?: string; at: number }[] = [];
  failNext = false;

  async send(m: { to: string; kind: AdminMailKind; link?: string; at: number }): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('메일 대역 실패');
    }
    this.sent.push({ ...m });
  }
}
