// 받는 층: multipart/form-data 본문 읽기(ADR-0257 결정 2). 플랫폼 해석기(@AcceptMultipart)가 상한 안의 바이트를 모아 두고,
// 칸은 Node 내장 Response.formData()(undici)로 나눈다. 새 패키지를 들이지 않는다. 깨진 본문은 400이다.
import { RequestValidationError } from '@peaket/platform';
import type { FastifyRequest } from 'fastify';
import type { UploadForm } from '../application/upload-form.js';

export async function readUploadForm(request: FastifyRequest): Promise<UploadForm> {
  const body = request.body;
  const type = request.headers['content-type'];
  if (!Buffer.isBuffer(body) || typeof type !== 'string') throw new RequestValidationError('multipart 본문이 없다');
  let data: FormData;
  try {
    data = await new Response(new Uint8Array(body.buffer, body.byteOffset, body.byteLength), { headers: { 'content-type': type } }).formData();
  } catch {
    throw new RequestValidationError('multipart 본문을 읽지 못했다');
  }
  // 칸을 나눈 뒤에는 원시 본문을 놓는다(본문을 한 벌만 쥔다, ADR-0257 결정 2)
  (request as { body?: unknown }).body = undefined;
  const form: UploadForm = { files: [], fields: [] };
  for (const [name, value] of data) {
    if (typeof value === 'string') form.fields.push({ name, value });
    else form.files.push({ field: name, name: value.name, type: value.type, size: value.size, bytes: async () => new Uint8Array(await value.arrayBuffer()) });
  }
  return form;
}

/** safelisted가 아닌 머리를 요구한다(multipart는 Content-Type이 safelisted라 교차 출처 위조를 막지 못한다, catalog-review 3.5.1) */
export function requireXRequestedWith(request: FastifyRequest): void {
  const v = request.headers['x-requested-with'];
  if (typeof v !== 'string' || v.trim() === '') throw new RequestValidationError('X-Requested-With 머리가 없다');
}
