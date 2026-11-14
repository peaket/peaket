// shop·notify 마이그레이션 정적 시험(BUILD_ORDER BAT-610 서버 잔여).
// Docker test-int는 웨이브 끝 heavy gate에서 돌리므로, 여기서는 SQL·journal·snapshot이 서로 맞는지만 본다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
const sql14 = read('migrations/0014_shop.sql');
const sql15 = read('migrations/0015_notify.sql');
const journal = JSON.parse(read('migrations/meta/_journal.json')) as { entries: { idx: number; tag: string }[] };

describe('shop·notify 마이그레이션', () => {
  test('journal이 0014_shop·0015_notify를 순서대로 갖는다', () => {
    expect(journal.entries.find((e) => e.idx === 14)?.tag).toBe('0014_shop');
    expect(journal.entries.find((e) => e.idx === 15)?.tag).toBe('0015_notify');
  });

  test('0014는 product·product_stock을 만들고 테넌트 RLS·권한을 건다', () => {
    expect(sql14).toContain('CREATE TABLE "product"');
    expect(sql14).toContain('CREATE TABLE "product_stock"');
    expect(sql14).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql14).toContain('CREATE POLICY product_partner_tenant');
    expect(sql14).toContain('CREATE POLICY product_stock_partner_tenant');
    expect(sql14).toContain('GRANT SELECT, INSERT, UPDATE ON product TO core_partner');
    expect(sql14).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON product_stock TO core_partner');
    expect(sql14).toContain("current_setting('app.tenant_id', true)");
    // 오래된 표를 다시 만들지 않는다(drizzle snapshot 공백 때문에 생성기가 다시 내보낸 것을 손으로 덜어냈다)
    expect(sql14).not.toContain('CREATE TABLE "event_sale_config"');
    expect(sql14).not.toContain('CREATE TABLE "review"');
  });

  test('0015는 webhook_endpoint·webhook_delivery를 만들고 테넌트 RLS·권한을 건다', () => {
    expect(sql15).toContain('CREATE TABLE "webhook_endpoint"');
    expect(sql15).toContain('CREATE TABLE "webhook_delivery"');
    expect(sql15).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql15).toContain('CREATE POLICY webhook_endpoint_partner_tenant');
    expect(sql15).toContain('CREATE POLICY webhook_delivery_partner_tenant');
    expect(sql15).toContain('GRANT SELECT, INSERT, UPDATE ON webhook_endpoint, webhook_delivery TO core_partner');
  });

  test('snapshot이 두 판의 표를 담는다', () => {
    const snap14 = JSON.parse(read('migrations/meta/0014_snapshot.json')) as { tables: Record<string, unknown> };
    const snap15 = JSON.parse(read('migrations/meta/0015_snapshot.json')) as { tables: Record<string, unknown> };
    expect(Object.keys(snap14.tables)).toEqual(expect.arrayContaining(['public.product', 'public.product_stock']));
    expect(Object.keys(snap15.tables)).toEqual(expect.arrayContaining(['public.webhook_endpoint', 'public.webhook_delivery']));
  });

  test('마이그레이션은 기존 표를 지우지 않는다', () => {
    for (const sql of [sql14, sql15]) {
      expect(sql).not.toMatch(/DROP TABLE/i);
      expect(sql).not.toMatch(/TRUNCATE/i);
    }
  });
});
