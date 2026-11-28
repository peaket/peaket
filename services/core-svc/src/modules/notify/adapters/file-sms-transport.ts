// F-06-1 문자 대행 파일 대역(local·ci·demo): PEAKET_NOTIFY_SMS_DIR/notification-sms.jsonl에 한 줄씩 쓴다.
// 운영 Solapi·알림톡 어댑터는 이 포트(SmsTransport)를 구현해 끼운다(F-06-6).
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SmsMessage, SmsSendResult, SmsTransport } from '../domain/fan-notify-ports.js';

export const NOTIFY_SMS_DIR_ENV = 'PEAKET_NOTIFY_SMS_DIR';
export const NOTIFY_SMS_FILE = 'notification-sms.jsonl';

export class FileSmsTransport implements SmsTransport {
  constructor(private readonly dir: string) {}

  async send(input: SmsMessage): Promise<SmsSendResult> {
    await mkdir(this.dir, { recursive: true });
    const line = JSON.stringify({ ...input, at: new Date().toISOString() });
    await appendFile(join(this.dir, NOTIFY_SMS_FILE), `${line}\n`, 'utf8');
    return { providerMessageId: `file-sms-${Buffer.from(input.messageKey).toString('base64url').slice(0, 16)}` };
  }
}

/** local·ci·demo에서 폴더 설정이 있으면 파일 대역, 없으면 null(운영 대행 없음) */
export function smsTransportFromEnv(env: Record<string, string | undefined>): SmsTransport | null {
  const dir = env[NOTIFY_SMS_DIR_ENV];
  if (!dir) return null;
  if (!['local', 'ci', 'demo'].includes(env.PEAKET_ENV ?? 'prod')) throw new Error(`${NOTIFY_SMS_DIR_ENV}(문자 파일 대역)는 local·ci·demo에서만 쓴다`);
  return new FileSmsTransport(dir);
}
