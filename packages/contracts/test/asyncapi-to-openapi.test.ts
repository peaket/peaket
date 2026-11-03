// AsyncAPI 메시지 본문을 OpenAPI 구성 요소로 옮기는 변환기(design.md 결정 3, 기술 검토 중간-085)
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { toOpenApi } from '../scripts/asyncapi-to-openapi.mjs';

const base = (messages: object, extra: object = {}) => ({
  asyncapi: '3.0.0',
  info: { title: '사건', version: '1.0.0' },
  defaultContentType: 'application/avro',
  components: { messages },
  ...extra,
});
const orderPayload = { type: 'object', required: ['orderId'], properties: { orderId: { type: 'string' } } };

describe('AsyncAPI → OpenAPI 구성 요소', () => {
  test('중간085_메시지본문을_메시지이름그대로_구성요소로옮긴다', () => {
    const out = toOpenApi(base({ OrderEvent: { payload: orderPayload } }));
    expect(out).toEqual({
      openapi: '3.1.0',
      info: { title: '사건', version: '1.0.0' },
      paths: {},
      components: { schemas: { OrderEvent: orderPayload } },
    });
  });

  test('중간085_바이너리메시지는_빼고_형식이없으면_기본형식을따른다', () => {
    const out = toOpenApi(base({
      OrderEvent: { payload: orderPayload },
      RumSample: { contentType: 'application/json', payload: orderPayload },
      SeatDeltaBatch: { contentType: 'application/octet-stream', payload: { type: 'string' } },
    }));
    expect(Object.keys(out.components.schemas)).toEqual(['OrderEvent', 'RumSample']);
    const binaryDefault = toOpenApi(base({
      Heartbeat: { payload: { type: 'string' } },
      CommandAck: { contentType: 'application/json', payload: orderPayload },
    }, { defaultContentType: 'application/octet-stream' }));
    expect(Object.keys(binaryDefault.components.schemas)).toEqual(['CommandAck']);
  });

  test('중간085_AsyncAPI구성요소스키마도옮기고_메시지이름과겹치면_실패한다', () => {
    const money = { type: 'integer' };
    const out = toOpenApi(base({ OrderEvent: { payload: { $ref: '#/components/schemas/Money' } } }, {
      components: { messages: { OrderEvent: { payload: { $ref: '#/components/schemas/Money' } } }, schemas: { Money: money } },
    }));
    expect(out.components.schemas).toEqual({ Money: money, OrderEvent: { $ref: '#/components/schemas/Money' } });
    expect(() => toOpenApi(base({}, {
      components: { messages: { Money: { payload: orderPayload } }, schemas: { Money: money } },
    }))).toThrow(/Money/);
  });

  test('중간085_구성요소스키마밖을가리키는ref는_옮긴문서에서풀리지않아_실패한다', () => {
    const payload = { type: 'object', properties: { inner: { $ref: '#/components/messages/Other' } } };
    expect(() => toOpenApi(base({ OrderEvent: { payload } }))).toThrow(/OrderEvent.*#\/components\/messages\/Other/);
  });

  test('중간085_본문이없거나_JSON스키마가아닌형식이면_실패한다', () => {
    expect(() => toOpenApi(base({ OrderEvent: { contentType: 'application/json' } }))).toThrow(/OrderEvent/);
    const avroFormat = { schemaFormat: 'application/vnd.apache.avro;version=1.9.0', schema: { type: 'record' } };
    expect(() => toOpenApi(base({ OrderEvent: { payload: avroFormat } }))).toThrow(/OrderEvent.*schemaFormat/);
  });

  test('중간085_원본문서를_바꾸지않는다', () => {
    const doc = base({ OrderEvent: { payload: orderPayload } });
    const before = structuredClone(doc);
    const out = toOpenApi(doc);
    (out.components.schemas.OrderEvent as { required: string[] }).required.push('changed');
    expect(doc).toEqual(before);
  });

  test('중간085_실제계약_주문사건은들어가고_좌석델타바이너리는빠진다', () => {
    const doc = parse(readFileSync(new URL('../../../docs/api/asyncapi.yaml', import.meta.url), 'utf8'));
    const names = Object.keys(toOpenApi(doc).components.schemas);
    expect(names).toContain('OrderEvent');
    expect(names).toContain('RumSample');
    expect(names).not.toContain('SeatDeltaBatch');
    expect(names).not.toContain('Heartbeat');
  });
});
