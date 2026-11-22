// BAT-455 메일 대행 파일 대역(local·ci): PEAKET_NOTIFY_MAIL_DIR/notification-mail.jsonl에 한 줄씩 쓴다.
// 운영 대행사 어댑터는 이 포트(MailTransport)를 구현해 끼운다(notify §4.4 ①~⑤ 조건).
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { MailMessage, MailSendResult, MailTransport } from '../domain/fan-notify-ports.js';

export const NOTIFY_MAIL_DIR_ENV = 'PEAKET_NOTIFY_MAIL_DIR';
export const NOTIFY_MAIL_FILE = 'notification-mail.jsonl';

export class FileMailTransport implements MailTransport {
  constructor(private readonly dir: string) {}

  async send(input: MailMessage): Promise<MailSendResult> {
    await mkdir(this.dir, { recursive: true });
    const line = JSON.stringify({ ...input, at: new Date().toISOString() });
    await appendFile(join(this.dir, NOTIFY_MAIL_FILE), `${line}\n`, 'utf8');
    return { providerMessageId: `file-${Buffer.from(input.messageKey).toString('base64url').slice(0, 16)}` };
  }
}

/** local·ci에서 폴더 설정이 있으면 파일 대역, 없으면 null(실제 대행 없음) */
export function mailTransportFromEnv(env: Record<string, string | undefined>): MailTransport | null {
  const dir = env[NOTIFY_MAIL_DIR_ENV];
  if (!dir) return null;
  if (!['local', 'ci', 'demo'].includes(env.PEAKET_ENV ?? 'prod')) throw new Error(`${NOTIFY_MAIL_DIR_ENV}(메일 파일 대역)는 local·ci·demo에서만 쓴다`);
  return new FileMailTransport(dir);
}
