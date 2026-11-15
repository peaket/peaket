// OPS-06 회귀: 응답 상한은 Content-Length와 실제 스트림 양쪽에서 64KiB로 자른다.
import { describe, expect, test } from 'vitest';
import { HttpsWebhookTransport, WebhookTransportError } from '../src/modules/notify/adapters/https-transport.js';

const INPUT = { url: 'https://partner.example.com/hook', headers: {}, body: '{}' };
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

const transport = (body: ReadableStream<Uint8Array> | null, contentLength?: string) =>
  new HttpsWebhookTransport({
    lookup,
    fetch: (async () => new Response(body, { status: 200, headers: contentLength === undefined ? {} : { 'content-length': contentLength } })) as typeof fetch,
  });

const streamOf = (size: number): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(size));
      c.close();
    },
  });

describe('OPS-06 웹훅 응답 상한 경계', () => {
  test('정확히 64KiB는 Content-Length가 있어도 받는다', async () => {
    await expect(transport(streamOf(64 * 1024), String(64 * 1024)).send(INPUT)).resolves.toEqual({ status: 200 });
  });

  test('Content-Length가 64KiB를 넘으면 본문이 없어도 읽지 않고 실패한다', async () => {
    await expect(transport(null, String(64 * 1024 + 1)).send(INPUT)).rejects.toBeInstanceOf(WebhookTransportError);
  });

  test('Content-Length가 크다고 속이면 실제 본문이 작아도 실패한다', async () => {
    await expect(transport(streamOf(1), String(64 * 1024 + 1)).send(INPUT)).rejects.toBeInstanceOf(WebhookTransportError);
  });

  test('Content-Length가 없어도 한 덩어리 64KiB+1은 실패한다', async () => {
    await expect(transport(streamOf(64 * 1024 + 1)).send(INPUT)).rejects.toBeInstanceOf(WebhookTransportError);
  });

  test('Content-Length가 없고 정확히 64KiB면 받는다', async () => {
    await expect(transport(streamOf(64 * 1024)).send(INPUT)).resolves.toEqual({ status: 200 });
  });
});
