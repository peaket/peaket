// drizzle-kit 설정: 모듈별 타입 정의에서 마이그레이션 SQL(migrations/)을 만든다.
// 운영 실행은 트랜잭션 안의 스키마·인덱스·제약·파티션 마이그레이션(BUILD_ORDER BAS-060)이다(ADR-0037 결정 6).
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/modules/ticket/adapters/db/schema.ts', './src/modules/scanner/adapters/db/schema.ts'],
  out: './migrations',
});
