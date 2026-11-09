// 바깥 제공자 응답 본문을 상한까지만 읽는다(유출 목록 범위 조회·사람 확인 검증). 넘으면 읽기를 멈추고 던진다(메모리에 끝없이 쌓지 않는다).

/** 본문을 maxBytes까지만 읽어 UTF-8 글로 돌려준다. 넘으면 Error(값은 싣지 않는다) */
export async function boundedText(r: Response, maxBytes: number): Promise<string> {
  const reader = r.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error('응답 본문이 상한을 넘었다');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
