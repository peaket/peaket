// 서비스 OpenAPI 문서 뽑기(D-T38, docs/devops.md §3.1, openspec 변경 add-service-template 결정 6).
// 실행 중인 서비스는 문서 경로를 내지 않는다(SwaggerModule.setup을 부르지 않는다, ASVS v5.0.0-13.4.5).
// 문서는 CI 안에서만 이 함수로 파일을 만들어 계약(docs/api/openapi.yaml)과 견준다(tools/ci/service-openapi.mjs).
import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import type { DynamicModule, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { DocumentBuilder, type SchemaObject, SwaggerModule } from '@nestjs/swagger';
import { z } from 'zod';
import { systemClock } from './clock.js';
import { platformRoot } from './service.js';
import { pino } from 'pino';

export interface EmitOpenApiOptions {
  module: Type<unknown> | DynamicModule;
  /** 쓸 파일. 서비스의 openapi:emit 스크립트는 환경 변수 OPENAPI_OUT을 넘긴다 */
  out: string;
  title: string;
  version?: string;
}

export async function emitOpenApi(o: EmitOpenApiOptions): Promise<void> {
  // 미리 보기 모드: 제공자·처리기를 만들지 않아 DB 연결 같은 시작 작업이 돌지 않는다
  const app = await NestFactory.create(platformRoot(o.module, systemClock, pino({ enabled: false })), new FastifyAdapter(), {
    logger: false,
    abortOnError: false,
    preview: true,
  });
  try {
    const doc = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle(o.title).setVersion(o.version ?? '0.0.0').build());
    writeFileSync(o.out, `${JSON.stringify(doc, null, 2)}\n`);
  } finally {
    await app.close();
  }
}

/**
 * 계약에서 만든 Zod 스키마(@peaket/contracts)를 swagger 데코레이터에 넣을 OpenAPI 스키마로 바꾼다.
 * 기본은 io: 'input'이다. 계약에서 만든 Zod의 입력 기준이 계약의 모양(기본값이 있는 칸은 선택)이라 서비스 문서가 계약과 같아진다(D-T38).
 * 'output'은 기본값이 채워진 뒤의 모양(기본값 칸이 필수)이다(코드 리뷰, 2026-11-01)
 */
export function contractSchema(schema: z.ZodType, options: { io?: 'input' | 'output' } = {}): SchemaObject {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { target: 'openapi-3.0', io: options.io ?? 'input' }) as Record<string, unknown>;
  return rest as SchemaObject;
}
