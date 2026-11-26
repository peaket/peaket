// F-04-14 받는 층: 외부 게시물 multipart 본문 읽기. 플랫폼 @AcceptMultipart가 상한 안의 바이트를 모아 두고,
// 칸은 Node 내장 Response.formData()로 나눈다(새 패키지를 들이지 않는다). 깨진 본문은 400이다.
import { RequestValidationError } from '@peaket/platform';
import type { FastifyRequest } from 'fastify';
import type { MaskRegion } from '../domain/fraud-evidence.js';

export interface EvidenceUploadForm {
  fields: Map<string, string[]>;
  files: { field: string; name: string; type: string; bytes: Uint8Array }[];
}

export async function readEvidenceUploadForm(request: FastifyRequest): Promise<EvidenceUploadForm> {
  const body = request.body;
  const type = request.headers['content-type'];
  if (!Buffer.isBuffer(body) || typeof type !== 'string') throw new RequestValidationError('multipart 본문이 없다');
  let data: FormData;
  try {
    data = await new Response(new Uint8Array(body.buffer, body.byteOffset, body.byteLength), { headers: { 'content-type': type } }).formData();
  } catch {
    throw new RequestValidationError('multipart 본문을 읽지 못했다');
  }
  (request as { body?: unknown }).body = undefined;
  const form: EvidenceUploadForm = { fields: new Map(), files: [] };
  for (const [name, value] of data) {
    if (typeof value === 'string') {
      form.fields.set(name, [...(form.fields.get(name) ?? []), value]);
    } else {
      form.files.push({ field: name, name: value.name, type: value.type, bytes: new Uint8Array(await value.arrayBuffer()) });
    }
  }
  return form;
}

export function requireXRequestedWith(request: FastifyRequest): void {
  const v = request.headers['x-requested-with'];
  if (typeof v !== 'string' || v.trim() === '') throw new RequestValidationError('X-Requested-With 머리가 없다');
}

export function maskRegionsOf(values: readonly string[]): readonly MaskRegion[] {
  const out: MaskRegion[] = [];
  for (const value of values) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new RequestValidationError('가릴 자리가 JSON이 아니다');
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of list) {
      if (item && typeof item === 'object') {
        const r = item as Record<string, unknown>;
        out.push({ x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h) });
      }
    }
  }
  return out;
}
