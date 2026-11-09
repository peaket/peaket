// 로컬·CI의 관리 계정 메일 대역: PEAKET_ADMIN_MAIL_DIR 폴더의 admin-mail.jsonl에 한 줄씩 쓴다(해제 링크 확인용, 저장소에 넣지 않는다, BUILD_ORDER BOT-121).
// 운영 발송 대행은 정본에 없다 [가정](docs/features/notify.md의 이메일 발송 대행과 함께 정한다).
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AdminMailer, AdminMailKind } from '../domain/ports.js';

export const ADMIN_MAIL_DIR_ENV = 'PEAKET_ADMIN_MAIL_DIR';

export class FileAdminMailer implements AdminMailer {
  constructor(private readonly dir: string) {}

  async send(m: { to: string; kind: AdminMailKind; link?: string; at: number }): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(join(this.dir, 'admin-mail.jsonl'), `${JSON.stringify({ ...m, at: new Date(m.at).toISOString() })}\n`, 'utf8');
  }
}

/** local·ci에서 폴더 설정이 있으면 파일 대역, 아니면 null(발송 고리를 돌리지 않는다) */
export function adminMailerFromEnv(env: Record<string, string | undefined>): AdminMailer | null {
  const dir = env[ADMIN_MAIL_DIR_ENV];
  if (!dir) return null;
  if (!['local', 'ci'].includes(env.PEAKET_ENV ?? 'prod')) throw new Error(`${ADMIN_MAIL_DIR_ENV}(메일 대역)는 local·ci에서만 쓴다`);
  return new FileAdminMailer(dir);
}
