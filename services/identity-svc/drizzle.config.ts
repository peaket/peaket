// drizzle-kit 설정: 표 정의(adapters/db/schema.ts)에서 마이그레이션 SQL(migrations/)을 만든다.
// generate만 쓴다. 로컬 시제품을 넘는 환경에서 push를 쓰지 않고, 실행은 마이그레이션 실행기(BUILD_ORDER BAS-060)가 한다(ADR-0037 결정 6).
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/modules/*/adapters/db/schema.ts',
  out: './migrations',
});
