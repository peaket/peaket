// 웹훅 HTTPS 발송기의 응답 상한 시험(OPS-06). 가짜 수신기로 Content-Length와 스트림 읽기 양쪽의 64KiB 상한을 본다.
import { describe, expect, test } from 'vitest';
import { HttpsWebhookTransport, WebhookTransportError } from '../src/modules/notify/adapters/https-transport.js';

const INPUT = { url: 'https://partner.example.com/hook', headers: {}, body: '{}' };
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

function streamed(chunks: readonly Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < chunks.length) c.enqueue(chunks[i++]!);
      else c.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

const transport = (body: ReadableStream<Uint8Array> | null, contentLength?: string) =>
  new HttpsWebhookTransport({
    lookup,
    fetch: (async () => new Response(body, { status: 200, headers: contentLength === undefined ? {} : { 'content-length': contentLength } })) as typeof fetch,
  });

describe('OPS-06 웹훅 응답 상한', () => {
  test('Content-Length가 64KiB를 넘으면 본문을 읽지 않고 연결을 끊고 실패한다', async () => {
    let cancelled = false;
    const t = transport(streamed([new Uint8Array(1)], () => (cancelled = true)), String(64 * 1024 + 1));
    await expect(t.send(INPUT)).rejects.toBeInstanceOf(WebhookTransportError);
    expect(cancelled).toBe(true);
  });

  test('Content-Length가 없어도 스트림이 64KiB를 넘으면 끊고 실패한다', async () => {
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const t = transport(endless);
    await expect(t.send(INPUT)).rejects.toBeInstanceOf(WebhookTransportError);
    expect(cancelled).toBe(true);
  });

  test('Content-Length가 작다고 속여도 실제 스트림이 넘으면 실패한다', async () => {
    const chunks = Array.from({ length: 65 }, () => new Uint8Array(1024));
    const t = transport(streamed(chunks), '1024');
    await expect(t.send(INPUT)).rejects.toBeInstanceOf(WebhookTransportError);
  });

  test('64KiB 이하 응답은 상태를 돌려준다', async () => {
    const t = transport(streamed([new Uint8Array(1024)]), '1024');
    await expect(t.send(INPUT)).resolves.toEqual({ status: 200 });
  });
});
