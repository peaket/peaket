// 생산자가 낸 Kafka 값(Outbox payload, 텔레메트리 버퍼에 넣은 값)을 시험 안에서 풀어 A-T26 '공통 판정'을 보는 도구(docs/features/analytics.md A-T26, F-04-2 계획 §6).
// 풀기는 제품 인코더(src/avro-encoder.ts)를 거치지 않고 avsc와 계약 판 스키마 생성물(@peaket/contracts/avro, docs/api/avro의 .avsc 그대로)로 한다.
// 서비스 시험(purchase-svc·trust-svc)도 이 파일을 상대 경로로 읽는다(avsc는 platform에만 의존 선언이 있다).
// 공통 판정 넷(A-T26): ① 앞 다섯 바이트가 매직 바이트 0과 설정(schema-ids)의 그 주제 ID ② 필수 칸이 모두 있고 x-present-when 조건이 맞는 칸은 값이 있다
// ③ 열거에 UNRECOGNIZED가 없다 ④ 계약에 없는 칸의 값이 바이트에 없다(④는 countUtf8로 시험이 값마다 본다).
import avsc from 'avsc';
import { avroSchemas } from '@peaket/contracts/avro';

type Field = { name: string; type: unknown; default?: unknown; 'x-present-when'?: unknown };

/** 바이트 안에 글(UTF-8)이 나온 횟수(겹치지 않게 센다) */
export function countUtf8(bytes: Uint8Array, text: string): number {
  const hay = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const needle = Buffer.from(text, 'utf8');
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n += 1;
  return n;
}

/** Confluent 머리(매직 바이트·스키마 ID)와 Avro 본문 */
export function confluentHeader(bytes: Uint8Array): { magic: number; schemaId: number } {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length < 5) throw new Error(`값이 다섯 바이트보다 짧다(${b.length})`);
  return { magic: b[0]!, schemaId: b.readUInt32BE(1) };
}

const contract = (record: string): { fields: Field[] } => {
  const s = avroSchemas[record] as { fields?: Field[] } | undefined;
  if (!s?.fields) throw new Error(`계약 판에 ${record}가 없다`);
  return s as { fields: Field[] };
};

/** 레코드마다 한 번만 만든다(많은 값을 푸는 통합 시험이 느려지지 않게) */
const types = new Map<string, avsc.Type>();
const typeOf = (record: string, schema: { fields: Field[] }): avsc.Type => {
  let t = types.get(record);
  if (!t) {
    t = avsc.Type.forSchema(schema as avsc.Schema, { wrapUnions: 'auto' });
    types.set(record, t);
  }
  return t;
};

/** x-present-when 조건 하나가 맞는가(값이 비면 그 칸의 기본값으로 본다). 정본: docs/api/asyncapi.yaml info '필수 여부' */
function holds(cond: Record<string, unknown[]>, value: Record<string, unknown>, fields: Field[]): boolean {
  return Object.entries(cond).every(([k, allowed]) => {
    const f = fields.find((x) => x.name === k);
    const v = value[k] ?? f?.default;
    return allowed.includes(v as never);
  });
}

/** 푼 값 안의 모든 글 값(열거 기호 포함)을 모은다 */
function strings(v: unknown, out: string[]): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v !== null && typeof v === 'object' && !Buffer.isBuffer(v)) for (const x of Object.values(v)) strings(x, out);
  return out;
}

export interface Produced {
  /** 쓴 쪽 스키마 ID(머리 4바이트) */
  schemaId: number;
  /** 계약 판으로 푼 값(timestamp-millis는 밀리초 수, null 갈래는 null) */
  value: Record<string, unknown>;
  /** 공통 판정 ②③을 어긴 칸(비어야 한다) */
  violations: string[];
}

/**
 * 생산자가 낸 값 하나를 풀고 공통 판정 ①②③을 본다.
 * @throws Error 매직 바이트가 0이 아니거나, 계약 판으로 풀리지 않거나, 다 읽은 뒤 바이트가 남음
 */
export function decodeProduced(bytes: Uint8Array, record: string): Produced {
  const { magic, schemaId } = confluentHeader(bytes);
  if (magic !== 0) throw new Error(`매직 바이트가 0이 아니다(${magic})`);
  const schema = contract(record);
  const type = typeOf(record, schema);
  const body = Buffer.from(bytes.buffer, bytes.byteOffset + 5, bytes.byteLength - 5);
  const { value, offset } = type.decode(body, 0);
  if (offset !== body.length) throw new Error(`계약 판으로 다 읽은 뒤 ${body.length - offset}바이트가 남았다(읽은 자리 ${offset})`);
  const plain = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  const violations: string[] = [];
  for (const f of schema.fields) {
    const v = plain[f.name];
    const when = f['x-present-when'];
    if (Array.isArray(when) && (v === null || v === undefined) && when.some((c) => holds(c as Record<string, unknown[]>, plain, schema.fields))) violations.push(`${f.name}: x-present-when`);
  }
  for (const s of strings(plain, [])) if (s === 'UNRECOGNIZED') violations.push('UNRECOGNIZED');
  return { schemaId, value: plain, violations };
}
