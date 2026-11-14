// 0004~0006 마이그레이션 파일이 재번호 뒤에도 있어야 할 것을 담는지 파일로 확인한다(BAT-465 R-584).
// 0003은 갈래 2(BAT-425 GAT-130)의 ops_alert·refund 명령 몫이라 여기서 보지 않는다.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const sql = (name: string): string => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');

describe('0004~0006 ops 마이그레이션', () => {
  test('R584_0004는_SALE_STOP_SALE_RESUME을_명령_유형_check에_넣는다', () => {
    const text = sql('0004_sale_stop_command_type.sql');
    expect(text).toContain('ops_command_type_check');
    expect(text).toContain("'SALE_STOP'");
    expect(text).toContain("'SALE_RESUME'");
    // 갈래 2의 유형을 지우지 않는다
    for (const t of ['EVENT_REFUND_PAUSE', 'EVENT_REFUND_RESUME', 'EVENT_CANCEL', 'SCALE_CHANGE']) expect(text, t).toContain(`'${t}'`);
  });

  test('R584_0005는_보류_표_held_event와_인덱스_셋을_만든다', () => {
    const text = sql('0005_held_event.sql');
    expect(text).toContain('CREATE TABLE "held_event"');
    expect(text).toContain('held_event_position_key');
    expect(text).toContain('held_event_event_key');
    expect(text).toContain('held_event_pending_idx');
  });

  test('R584_0006은_감사_체크포인트에_서명과_앵커_칸을_더한다', () => {
    const text = sql('0006_audit_anchor.sql');
    for (const c of ['signature', 'key_id', 'anchor_ref', 'anchored_at']) expect(text, c).toContain(`ADD COLUMN IF NOT EXISTS ${c}`);
  });
});
