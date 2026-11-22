// BAT-455 웹 푸시 파일 대역(local·ci): PEAKET_NOTIFY_PUSH_DIR/notification-push.jsonl에 보낼 봉투를 남긴다.
// 암호문·머리는 실제 값이고 바깥으로 나가지 않는다(BUILD_ORDER GAT-250 '로컬 대역').
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PushSendInput, PushSendResult, PushTransport } from '../domain/fan-notify-ports.js';

export const NOTIFY_PUSH_DIR_ENV = 'PEAKET_NOTIFY_PUSH_DIR';
export const NOTIFY_PUSH_FILE = 'notification-push.jsonl';

export class FilePushTransport implements PushTransport {
  constructor(private readonly dir: string) {}

  async send(input: PushSendInput): Promise<PushSendResult> {
    await mkdir(this.dir, { recursive: true });
    const line = JSON.stringify({ endpointHash: input.subscriptionKey, service: input.service, headers: input.headers, body: input.body.toString('base64'), at: new Date().toISOString() });
    await appendFile(join(this.dir, NOTIFY_PUSH_FILE), `${line}\n`, 'utf8');
    return { status: 201 };
  }
}

export function pushTransportFromEnv(env: Record<string, string | undefined>): PushTransport | null {
  const dir = env[NOTIFY_PUSH_DIR_ENV];
  if (!dir) return null;
  if (!['local', 'ci', 'demo'].includes(env.PEAKET_ENV ?? 'prod')) throw new Error(`${NOTIFY_PUSH_DIR_ENV}(웹 푸시 파일 대역)는 local·ci·demo에서만 쓴다`);
  return new FilePushTransport(dir);
}
