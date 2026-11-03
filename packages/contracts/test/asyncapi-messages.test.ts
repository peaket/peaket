// 계약 깨짐 검사가 쓰는 메시지 본문 변환(openspec 변경 add-contract-breaking-check, design.md 결정 4, D-T48).
// 메시지마다 읽기 작업(GET /messages/<이름>의 200 응답)을 붙여, oasdiff의 응답 규칙으로 본문 깨짐을 견주게 한다.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { messagesAsOperations } from '../scripts/asyncapi-messages.mjs';

test('DT48_메시지마다_읽기작업을붙이고_바이너리와구성요소스키마는_작업으로만들지않는다', () => {
  const doc = messagesAsOperations({
    asyncapi: '3.0.0', info: { title: 't', version: '1' }, defaultContentType: 'application/avro',
    components: {
      messages: { M: { payload: { type: 'object' } }, Bin: { contentType: 'application/octet-stream', payload: { type: 'string' } } },
      schemas: { Money: { type: 'integer' } },
    },
  });
  expect(Object.keys(doc.paths)).toEqual(['/messages/M']);
  expect(doc.paths['/messages/M'].get).toEqual({
    operationId: 'readM',
    responses: { '200': { description: 'M', content: { 'application/json': { schema: { $ref: '#/components/schemas/M' } } } } },
  });
  expect(Object.keys(doc.components.schemas)).toEqual(['Money', 'M']);
});

test('DT48_내용형식으로_JSON메시지와Avro메시지를나눠고른다', () => {
  // JSON 메시지는 화면이 생성 Zod로 읽어 열거 값 더하기도 깨짐이고, Avro는 UNRECOGNIZED 규칙으로 받는다(깨짐 검사가 수준을 달리한다)
  const doc = {
    asyncapi: '3.0.0', info: { title: 't', version: '1' }, defaultContentType: 'application/avro',
    components: { messages: {
      OrderEvent: { payload: { type: 'object' } },
      OpsAlert: { contentType: 'application/json', payload: { type: 'object' } },
      Seat: { contentType: 'application/octet-stream', payload: { type: 'string' } },
    } },
  };
  expect(Object.keys(messagesAsOperations(doc, 'json').paths)).toEqual(['/messages/OpsAlert']);
  expect(Object.keys(messagesAsOperations(doc, 'avro').paths)).toEqual(['/messages/OrderEvent']);
  expect(Object.keys(messagesAsOperations(doc).paths)).toEqual(['/messages/OrderEvent', '/messages/OpsAlert']);
  expect(() => messagesAsOperations(doc, 'xml' as never)).toThrow(/json|avro/);
});

test('DT48_명령으로부르면_YAML을읽어_JSON으로쓴다', () => {
  const work = mkdtempSync(join(tmpdir(), 'asyncapi-messages-'));
  try {
    writeFileSync(join(work, 'in.yaml'), 'asyncapi: 3.0.0\ninfo: { title: t, version: "1" }\ndefaultContentType: application/avro\ncomponents: { messages: { OrderEvent: { payload: { type: object } } } }\n');
    const script = fileURLToPath(new URL('../scripts/asyncapi-messages.mjs', import.meta.url));
    execFileSync(process.execPath, [script, join(work, 'in.yaml'), join(work, 'out.json')]);
    expect(Object.keys(JSON.parse(readFileSync(join(work, 'out.json'), 'utf8')).paths)).toEqual(['/messages/OrderEvent']);
    execFileSync(process.execPath, [script, join(work, 'in.yaml'), join(work, 'json.json'), 'json']);
    expect(JSON.parse(readFileSync(join(work, 'json.json'), 'utf8')).paths).toEqual({});
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
