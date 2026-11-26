// F-04-19 연구 내보내기 순수 모델 시험(동결 로컬, LCH-330·LCH-340).
// 정본: docs/features/forensic-replay.md §4.2·§6.3·§6.6·§8(FX-T10·T17), docs/features/analytics.md §3.2·§11,
// docs/security/asvs/forensic-replay.md 1.2.4·2.2.3·2.4.1·8.2.1·8.2.2·8.2.3·13.2.2·16.2.1·16.2.5·16.3.3.
// 기준 트리에서는 모듈이 없어 단언으로 실패한다. 파일이 있는데 안쪽 import가 깨지면 오류를 다시 던진다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const DAY = 86_400_000;
const MODULE_PATH = '../src/modules/research-exports/domain/research-export.ts';
const MODULE_DIR = fileURLToPath(new URL('../src/modules/research-exports', import.meta.url));

/** 파일이 없으면 null(단언 실패), 있는데 import가 깨지면 그 오류를 그대로 던진다. */
async function load(rel: string): Promise<Record<string, any> | null> {
  const url = new URL(rel, import.meta.url);
  if (!existsSync(fileURLToPath(url))) return null;
  return (await import(/* @vite-ignore */ url.href)) as Record<string, any>;
}

const moduleOf = async () => {
  const mod = await load(MODULE_PATH);
  expect(mod, `${MODULE_PATH}가 아직 없다`).not.toBeNull();
  return mod;
};

const COLUMNS = [
  't_ms', 'kind', 'seat', 'section', 'session', 'result', 'retry', 'latency_ms',
  'first_hold_ms', 'entropy', 'net_type', 'asn', 'device_group', 'bot_tier', 'member', 'post_seat',
];

const record = (o: Record<string, unknown> = {}) => ({
  exportId: '0194b240-0000-7000-8000-000000000001',
  eventId: '0194b240-0000-7000-8000-000000000002',
  createdBy: '0194b240-0000-7000-8000-000000000003',
  createdBySessionId: '0194b240-0000-7000-8000-000000000004',
  fromMs: 0,
  toMs: 1_800_000,
  reason: '다음 회차 봇 판정 규칙 개선',
  allowlistVersion: 'v1',
  keyVersion: 'analytics-v1',
  status: 'PENDING',
  createdAtMs: 1_800_000_000_000,
  readyAtMs: null,
  expiresAtMs: 1_800_001_800_000,
  rowCount: 0,
  columns: COLUMNS,
  failureType: null,
  ...o,
});

const saleEndsAtMs = 1_800_000_000_000 - DAY;

describe('F-04-19 연구 내보내기 순수 모델', () => {
  test('FX-T10 ③ [ASVS v5.0.0-2.2.3] 시간창은 0 이상 30분 이하·시작<끝만 받고 경계를 포함한다', async () => {
    const m = await moduleOf();
    if (!m) return;
    const at = (fromMs: number, toMs: number) => m.checkResearchWindow({ fromMs, toMs, saleEndsAtMs, nowMs: saleEndsAtMs });

    expect(at(0, 1_800_000)).toBeNull();
    expect(at(0, 1)).toBeNull();
    expect(at(1_799_999, 1_800_000)).toBeNull();
    expect(at(-1, 1_800_000)).toBe('WINDOW_INVALID');
    expect(at(0, 1_800_001)).toBe('WINDOW_INVALID');
    expect(at(1_800_000, 1_800_000)).toBe('WINDOW_INVALID');
    expect(at(1_800_000, 0)).toBe('WINDOW_INVALID');
    expect(at(0.5, 1_800_000)).toBe('WINDOW_INVALID');
    expect(at(0, 1.5)).toBe('WINDOW_INVALID');
    expect(m.RESEARCH_WINDOW_MS).toBe(1_800_000);
  });

  test('FX-T10 ④ [ASVS v5.0.0-2.2.3] 판매 종료+90일 경계까지 보내고 1ms 뒤는 보존 만료다', async () => {
    const m = await moduleOf();
    if (!m) return;
    const window = { fromMs: 0, toMs: 1_800_000 };
    const ends = 1_700_000_000_000;
    expect(m.checkResearchWindow({ ...window, saleEndsAtMs: ends, nowMs: ends + 90 * DAY })).toBeNull();
    expect(m.checkResearchWindow({ ...window, saleEndsAtMs: ends, nowMs: ends + 90 * DAY + 1 })).toBe('RETENTION_ENDED');
    expect(m.checkResearchWindow({ ...window, saleEndsAtMs: ends + DAY, nowMs: ends })).toBeNull();
    expect(m.checkResearchWindow({ fromMs: -1, toMs: 1, saleEndsAtMs: ends, nowMs: ends + 91 * DAY })).toBe('WINDOW_INVALID');
    expect(m.RESEARCH_RETENTION_MS).toBe(90 * DAY);
  });

  test('FX-T10 ⑤ [ASVS v5.0.0-2.4.1] 하루 한도는 UTC 날짜로 5회이고 5회째까지 허용한다', async () => {
    const m = await moduleOf();
    if (!m) return;
    expect(m.researchDayKey(Date.UTC(2026, 10, 27, 23, 59, 59, 999))).toBe('2026-11-27');
    expect(m.researchDayKey(Date.UTC(2026, 10, 28, 0, 0, 0, 0))).toBe('2026-11-28');
    expect(m.RESEARCH_DAILY_LIMIT).toBe(5);
    expect(m.RESEARCH_EXPORT_TTL_MS).toBe(1_800_000);
    expect(m.researchQuotaExceeded(4)).toBe(false);
    expect(m.researchQuotaExceeded(5)).toBe(true);
    expect(m.researchQuotaExceeded(6)).toBe(true);
  });

  test('FX-T10 ⑦ [ASVS v5.0.0-8.2.3] 열은 16개 허용 목록뿐이고 entropy는 NaN·나머지 여섯은 0으로 비운다', async () => {
    const m = await moduleOf();
    if (!m) return;
    expect(m.researchOutputColumns()).toEqual(COLUMNS);
    for (const col of COLUMNS) {
      if (col === 'entropy') expect(m.researchMaskExpression(col)).toBe("toFloat32('nan')");
      else if (col === 'net_type' || col === 'member' || col === 'post_seat') expect(m.researchMaskExpression(col)).toBe('toUInt8(0)');
      else if (col === 'asn' || col === 'device_group') expect(m.researchMaskExpression(col)).toBe('toUInt32(0)');
      else expect(m.researchMaskExpression(col)).toBe(col);
    }
    const select = m.researchSelectList();
    expect(select).toHaveLength(16);
    expect(select).toEqual([
      't_ms AS t_ms', 'kind AS kind', 'seat AS seat', 'section AS section',
      'dense_rank() OVER (ORDER BY session_ref) AS session',
      'result AS result', 'retry AS retry', 'latency_ms AS latency_ms', 'first_hold_ms AS first_hold_ms',
      "toFloat32('nan') AS entropy", 'toUInt8(0) AS net_type', 'toUInt32(0) AS asn', 'toUInt32(0) AS device_group',
      'bot_tier AS bot_tier', 'toUInt8(0) AS member', 'toUInt8(0) AS post_seat',
    ]);
    expect(select.map((x: string) => x.split(' AS ')[1])).toEqual(COLUMNS);
    expect(select[4]).toBe('dense_rank() OVER (ORDER BY session_ref) AS session');
    expect(select[9]).toBe("toFloat32('nan') AS entropy");
    expect(select[10]).toBe('toUInt8(0) AS net_type');
    expect(select[11]).toBe('toUInt32(0) AS asn');
    expect(select[12]).toBe('toUInt32(0) AS device_group');
    expect(select[14]).toBe('toUInt8(0) AS member');
    expect(select[15]).toBe('toUInt8(0) AS post_seat');

    const ok = { byteLength: 12, head: 'ARROW1', tail: 'ARROW1', columns: COLUMNS, rowCount: 0 };
    expect(m.researchFileProblem(ok)).toBeNull();
    expect(m.researchFileProblem({ ...ok, byteLength: 200 * 1024 * 1024 + 1 })).toBe('TOO_LARGE');
    expect(m.researchFileProblem({ ...ok, byteLength: 11 })).toBe('INVALID_ENVELOPE');
    expect(m.researchFileProblem({ ...ok, head: 'ARROW2' })).toBe('INVALID_ENVELOPE');
    expect(m.researchFileProblem({ ...ok, tail: '' })).toBe('INVALID_ENVELOPE');
    expect(m.researchFileProblem({ ...ok, columns: COLUMNS.slice(0, 15) })).toBe('INVALID_COLUMNS');
    expect(m.researchFileProblem({ ...ok, columns: [...COLUMNS].reverse() })).toBe('INVALID_COLUMNS');
    expect(m.researchFileProblem({ ...ok, rowCount: -1 })).toBe('INVALID_ROW_COUNT');
    expect(m.researchFileProblem({ ...ok, rowCount: 1.5 })).toBe('INVALID_ROW_COUNT');
  });

  test('FX-T10 ⑦ [ASVS v5.0.0-1.2.4] 회차·시간창은 매개변수로만 넘기고 사용자 값을 SQL에 잇지 않는다', async () => {
    const m = await moduleOf();
    if (!m) return;
    const evil = "x' OR 1=1 --";
    const q = m.researchQuery({ eventId: evil, fromMs: 100, toMs: 200 });
    expect(q.params).toEqual({ eventId: evil, fromMs: 100, toMs: 200 });
    expect(q.sql).not.toContain(evil);
    expect(q.sql).not.toContain('OR 1=1');
    expect(q.sql).toContain('{eventId:String}');
    expect(q.sql).toContain('{fromMs:Int64}');
    expect(q.sql).toContain('{toMs:Int64}');
  });

  test('FX-T17 ② [ASVS v5.0.0-13.2.2] 연구 질의는 실버 7표만 읽고 inv·trust.behavior_raw를 읽지 않는다', async () => {
    const m = await moduleOf();
    if (!m) return;
    const q = m.researchQuery({ eventId: 'e', fromMs: 0, toMs: 1 });
    const tables = ['slv_queue_entry', 'slv_purchase_session', 'slv_hold_attempt', 'slv_seat_change', 'slv_payment_attempt', 'slv_ticket', 'slv_trust_label'];
    for (const t of tables) expect(q.sql, t).toContain(`silver.${t}`);
    const refs = [...q.sql.matchAll(/silver\.([a-z_]+)/g)].map((x: RegExpMatchArray) => x[1]);
    expect(new Set(refs)).toEqual(new Set(tables));
    expect(refs).toHaveLength(7);
    expect(q.sql).not.toMatch(/\b(bronze|gold|trust|inv)\./);
    expect(q.sql).toContain('FORMAT ArrowStream');
    expect(q.sql).toContain("output_format_arrow_compression_method = 'none'");
    expect(q.sql).toContain('output_format_arrow_low_cardinality_as_dictionary = 0');
    expect(q.sql).toContain('dense_rank() OVER (ORDER BY session_ref)');
    for (const col of ['entropy', 'net_type', 'asn', 'device_group', 'member', 'post_seat']) {
      expect(q.sql, col).toContain(m.researchMaskExpression(col));
    }
    let last = -1;
    for (const expr of m.researchSelectList()) {
      const at = q.sql.indexOf(expr);
      expect(at, expr).toBeGreaterThan(last);
      last = at;
    }
    for (const bad of ['inv.', 'trust.behavior_raw', 'journeyId', 'deviceRef', 'contactRef', 'paymentMethodRef', 'cardBin', 'raw_ip']) {
      expect(q.sql, bad).not.toContain(bad);
    }
  });

  test('A-T23 ③ [ASVS v5.0.0-8.2.1] 지정 검사는 PSEUDONYM_HANDLER만 통과하고 없음·조사관 겹침은 거절한다', async () => {
    const m = await moduleOf();
    if (!m) return;
    expect(m.researchDesignationProblem(['PSEUDONYM_HANDLER'])).toBeNull();
    expect(m.researchDesignationProblem(['PSEUDONYM_HANDLER', 'ACCESS_REVIEWER'])).toBeNull();
    expect(m.researchDesignationProblem([])).toBe('pseudonym-handler-required');
    expect(m.researchDesignationProblem(['FRAUD_INVESTIGATOR'])).toBe('pseudonym-handler-required');
    expect(m.researchDesignationProblem(['PSEUDONYM_HANDLER', 'FRAUD_INVESTIGATOR'])).toBe('pseudonym-handler-required');
  });

  test('A-T23 ④ [ASVS v5.0.0-16.2.1] [ASVS v5.0.0-16.2.5] 이용 내역은 SCIENTIFIC_RESEARCH 목적과 이용 내역만 담고 계정·IP·사유 원문을 담지 않는다', async () => {
    const m = await moduleOf();
    if (!m) return;
    const nowMs = 1_800_000_500_000;
    const r = record();
    const row = m.pseudonymizationLogRow({ record: r, saleEndsAtMs, outcome: 'RECEIVED', rowCount: 7, nowMs });
    expect(row.eventId).toBe(r.eventId);
    expect(row.purpose).toBe('SCIENTIFIC_RESEARCH');
    expect(row.keyVersion).toBe('analytics-v1');
    expect(row.processedFromMs).toBe(nowMs);
    expect(row.destroyDueAtMs).toBe(saleEndsAtMs + 90 * DAY);
    expect(row.items).toBe('회차 가명 세션 번호, 구역·좌석, 단계 시각·결과·응답 지연, 사후 판정 등급');
    expect(Object.keys(row).sort()).toEqual(['destroyDueAtMs', 'eventId', 'items', 'keyVersion', 'processedFromMs', 'purpose', 'usage']);
    expect(Object.keys(row.usage).sort()).toEqual(['columns', 'exportId', 'fromMs', 'outcome', 'rowCount', 'toMs']);
    expect(row.usage).toMatchObject({ exportId: r.exportId, fromMs: 0, toMs: 1_800_000, rowCount: 7, outcome: 'RECEIVED', columns: COLUMNS });
    expect(row.usage.problemType).toBeUndefined();
    expect(row).not.toHaveProperty('id');
    expect(row).not.toHaveProperty('destroyedAt');
    const text = JSON.stringify(row);
    for (const bad of [r.createdBy, r.createdBySessionId, 'IP', '10.0.0.1', 'x-forwarded', r.reason]) expect(text).not.toContain(bad);

    const denied = m.pseudonymizationLogRow({ record: r, saleEndsAtMs, outcome: 'DENIED', problemType: 'pseudonym-handler-required', nowMs });
    expect(denied.usage.problemType).toBe('pseudonym-handler-required');
    expect(Object.keys(denied).sort()).toEqual(['destroyDueAtMs', 'eventId', 'items', 'keyVersion', 'processedFromMs', 'purpose', 'usage']);

    const created = m.researchAuditRecord({ record: r, outcome: 'REQUESTED', actorRole: 'commander', nowMs });
    expect(created.recordType).toBe('RESEARCH_EXPORT');
    expect(created.recordId).toBe(r.exportId);
    expect(created.nowMs).toBe(nowMs);
    expect(created.payload).toMatchObject({
      action: 'CREATE',
      accountId: r.createdBy,
      role: 'commander',
      eventId: r.eventId,
      fromMs: 0,
      toMs: 1_800_000,
      columns: COLUMNS,
      rowCount: 0,
      reason: r.reason,
      outcome: 'REQUESTED',
      atMs: nowMs,
    });
    expect(created.payload.problemType).toBeUndefined();
    const deniedAudit = m.researchAuditRecord({ record: r, outcome: 'DENIED', problemType: 'pseudonym-handler-required', actorRole: 'commander', nowMs });
    expect(deniedAudit.payload).toMatchObject({ action: 'DENY', outcome: 'DENIED', problemType: 'pseudonym-handler-required', rowCount: 0 });
    expect(deniedAudit.recordId).toBeTruthy();
    const received = m.researchAuditRecord({ record: r, outcome: 'RECEIVED', actorRole: 'commander', nowMs });
    expect(received.payload).toMatchObject({ action: 'RECEIVE', outcome: 'RECEIVED' });
    const failed = m.researchAuditRecord({ record: r, outcome: 'FAILED', problemType: 'INVALID_COLUMNS', actorRole: 'commander', nowMs });
    expect(failed.payload).toMatchObject({ action: 'BUILD_FAILED', outcome: 'FAILED', problemType: 'INVALID_COLUMNS' });
  });

  test('FX-T10 ⑧ [ASVS v5.0.0-3.5.3] 받기는 cors·same-origin fetch만 허용하고 navigate·cross-site·머리 없음은 거절한다', async () => {
    const m = await moduleOf();
    if (!m) return;
    expect(m.researchFetchAllowed({ mode: 'cors', site: 'same-origin' })).toBe(true);
    expect(m.researchFetchAllowed({ mode: 'same-origin', site: 'same-origin' })).toBe(true);
    expect(m.researchFetchAllowed({ mode: 'CORS', site: 'SAME-ORIGIN' })).toBe(true);
    expect(m.researchFetchAllowed({ mode: 'navigate', site: 'same-origin' })).toBe(false);
    expect(m.researchFetchAllowed({ mode: 'cors', site: 'cross-site' })).toBe(false);
    expect(m.researchFetchAllowed({ mode: 'cors', site: 'same-site' })).toBe(false);
    expect(m.researchFetchAllowed({})).toBe(false);
  });

  test('FX-T10 ⑨ [ASVS v5.0.0-8.2.2] 만든 계정과 세션 모두 같아야 받을 수 있다', async () => {
    const m = await moduleOf();
    if (!m) return;
    const r = record();
    const actor = { accountId: r.createdBy, sessionId: r.createdBySessionId, role: 'commander', designations: ['PSEUDONYM_HANDLER'] };
    expect(m.researchExportSessionAllowed(r, actor)).toBe(true);
    expect(m.researchExportSessionAllowed(r, { ...actor, sessionId: 'other' })).toBe(false);
    expect(m.researchExportSessionAllowed(r, { ...actor, accountId: 'other' })).toBe(false);
    expect(m.researchExportSessionAllowed(r, { ...actor, role: 'cs_lead' })).toBe(true);
  });

  test('FX-T10 ⑪ [ASVS v5.0.0-16.3.3] 거절 3회/10분이면 경보하고 2회·10분 밖은 경보하지 않는다', async () => {
    const m = await moduleOf();
    if (!m) return;
    const now = 1_800_000_000_000;
    expect(m.RESEARCH_DENIAL_ALERT_THRESHOLD).toBe(3);
    expect(m.RESEARCH_DENIAL_ALERT_WINDOW_MS).toBe(600_000);
    expect(m.recentDenialCount([now - 600_000, now - 1], now)).toBe(2);
    expect(m.recentDenialCount([now - 600_000, now - 1, now], now)).toBe(3);
    expect(m.recentDenialCount([now - 600_001, now - 1, now], now)).toBe(2);
    expect(m.recentDenialCount([now - 1, now, now], now)).toBe(3);
    expect(m.recentDenialCount([], now)).toBe(0);
    expect(m.denialAlertDue(2)).toBe(false);
    expect(m.denialAlertDue(3)).toBe(true);
    expect(m.denialAlertDue(4)).toBe(false);
    expect(m.denialAlertDue(5)).toBe(false);
    expect(m.denialAlertDue(6)).toBe(false);
    expect(m.denialAlertDue(9)).toBe(false);
  });

  test('FX-T17 ① [ASVS v5.0.0-13.2.2] 연구 모듈은 조사 모듈·inv 저장소를 import하지 않고 main.ts·AppModule 두 갈래에 조립된다', async () => {
    const m = await moduleOf();
    if (!m) return;
    expect(existsSync(MODULE_DIR), `${MODULE_DIR}가 아직 없다`).toBe(true);
    const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts')) files.push(p);
      }
    };
    walk(MODULE_DIR);
    expect(files.length, '연구 모듈 파일이 없다').toBeGreaterThan(0);
    for (const file of files) {
      const src = strip(readFileSync(file, 'utf8'));
      const at = relative(MODULE_DIR, file);
      for (const bad of ['../investigations', 'inv_reader', 'trust.behavior_raw', 'journeyId', 'deviceRef', 'contactRef', 'paymentMethodRef', 'cardBin']) {
        expect(src, `${at}: ${bad}`).not.toContain(bad);
      }
    }
    // 시작 파일·AppModule 조립: import + 메모리·DB 등록 두 곳, main.ts의 코드(주석 아님)를 본다.
    const app = strip(readFileSync(new URL('../src/app.module.ts', import.meta.url), 'utf8'));
    const main = strip(readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8'));
    expect(app).toContain('ResearchExportsModule');
    expect((app.match(/ResearchExportsModule\.register/g) ?? []).length, 'app.module.ts의 메모리·DB 두 갈래').toBeGreaterThanOrEqual(2);
    expect(main).toContain('researchWiringFromEnv(');
    expect(main).toContain('research:');

    // 환경 값이 하나라도 없으면 disabled, 다섯이 모두 있으면 config로 조립한다.
    const base = {
      PEAKET_RESEARCH_CLICKHOUSE_URL: 'http://clickhouse',
      PEAKET_RESEARCH_CLICKHOUSE_USER: 'an_forensic_reader',
      PEAKET_RESEARCH_ALLOWLIST_VERSION: 'v1',
      PEAKET_RESEARCH_APPROVED_REVIEW_VERSIONS: 'v1, v2',
      PEAKET_RESEARCH_PSEUDONYM_KEY_VERSION: 'analytics-v1',
    };
    expect(m.researchWiringFromEnv({})).toEqual({ enabled: false });
    expect(m.researchWiringFromEnv({ ...base, PEAKET_RESEARCH_CLICKHOUSE_URL: '' })).toEqual({ enabled: false });
    expect(m.researchWiringFromEnv({ ...base, PEAKET_RESEARCH_PSEUDONYM_KEY_VERSION: undefined })).toEqual({ enabled: false });
    expect(m.researchWiringFromEnv(base)).toEqual({
      enabled: true,
      config: { allowlistVersion: 'v1', approvedReviewVersions: ['v1', 'v2'], keyVersion: 'analytics-v1' },
    });
  });
});
