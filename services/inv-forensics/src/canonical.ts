// RFC 8785(JSON을 한 가지 모양으로 적는 규칙) 정규 JSON과 SHA-256. 동결 로컬 F-04-11.
// 키를 UTF-16 순으로 정렬하고 공백 없이 적는다. 수는 ECMAScript의 수 표기를 쓴다.
// NaN·Infinity·undefined는 정규 JSON이 될 수 없으므로 던진다(ASVS v5.0.0-1.4.2).
import { createHash } from 'node:crypto';

export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error('정규 JSON: 유한한 수만 쓸 수 있다');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
      const obj = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(obj).sort()) {
        const v = obj[key];
        if (v === undefined) throw new Error(`정규 JSON: undefined 값은 쓸 수 없다(${key})`);
        parts.push(`${JSON.stringify(key)}:${canonicalize(v)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new Error(`정규 JSON: 지원하지 않는 값 ${typeof value}`);
  }
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}
