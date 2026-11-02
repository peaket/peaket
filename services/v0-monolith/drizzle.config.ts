// drizzle-kit 설정: 표 정의(adapters/db/schema.ts)에서 마이그레이션 SQL(migrations/)을 만든다(pnpm db:generate).
// generate만 쓴다. 실행은 scripts/migrate.mjs(Drizzle 마이그레이터, 로컬·시험)다. 운영 실행기는 BUILD_ORDER BAS-060(ADR-0037 결정 6).
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/modules/*/adapters/db/schema.ts',
  out: './migrations',
});
