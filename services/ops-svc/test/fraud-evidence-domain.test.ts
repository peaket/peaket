// F-04-14 증거 묶음·내보내기·외부 게시물 도메인 시험(동결 로컬, LCH-290·LCH-300, FX-T13·FX-T19·FX-T20·FX-T23·R-T35).
// 정본: docs/features/forensic-replay.md §6.7.6~§6.7.8, docs/infra.md §9, docs/security/secrets-and-keys.md,
// docs/features/transfer-refund.md §7.4, docs/api/openapi.yaml 태그 investigations.
// [ASVS v5.0.0-11.1.2] 해시 판·알고리즘, [ASVS v5.0.0-14.2.6] 최소화, [ASVS v5.0.0-16.4.2] 관리 연속성.
import { describe, expect, test } from 'vitest';
import * as inv from '../src/modules/investigations/index.js';
import { DAY, HOUR, NOW, id, makeIccPng, makeJpegWithExif, makePdf, makePng, makePngHeader, makePngOfSize, pixelAt, readPng, sha256 } from './fraud-evidence-support.js';

const ev = inv as unknown as Record<string, any>;
const A = (n: number) => id(0x1000 + n);
const T = (n: number) => id(0x2000 + n);

const problemStatus = (fn: () => unknown): number => {
  try {
    fn();
  } catch (e) {
    return Number((e as { status?: unknown }).status ?? 0);
  }
  return 0;
};

describe('F-04-14 도메인', () => {
  test('FX-T13 ① [ASVS v5.0.0-11.1.2] 목록 파일은 정한 모양의 RFC 8785 JSON이고 파일 해시·크기를 사전순으로 싣는다', () => {
    const a = Buffer.from('ARROW1-a');
    const b = Buffer.from('ARROW1-b');
    const made = ev.manifestOf({ caseId: id(0x400), eventId: id(0x200), createdAtMs: NOW, files: [{ name: 'records/inv_step.arrow', bytes: a }, { name: 'case.json', bytes: b }] });
    expect(made.files.map((f: any) => f.name)).toEqual(['case.json', 'records/inv_step.arrow']);
    expect(made.files[0]).toMatchObject({ sha256: sha256(b), sizeBytes: b.length });
    expect(sha256(Buffer.from(made.bytes))).toBe(made.manifestSha256);
    const parsed = JSON.parse(Buffer.from(made.bytes).toString('utf8'));
    expect(parsed).toMatchObject({ format: 'PEAKET-evidence-v1', algorithm: 'sha256', caseId: id(0x400), eventId: id(0x200), createdAt: isoOf(NOW) });
    expect(parsed.files.map((f: any) => f.name)).toEqual(['case.json', 'records/inv_step.arrow']);
    expect(Buffer.from(made.bytes).toString('utf8')).toBe(ev.canonicalJson(parsed));
  });

  test('FX-T13 ② 관리 연속성 행 해시는 이전 행 해시를 이어 사슬을 만들고 한 행을 바꾸면 끊긴다', () => {
    const base = { bundleId: id(0x500), action: 'CREATED' as const, actorId: A(1), reason: null, exportKind: null, dataRequestId: null, occurredAtMs: NOW };
    const first = { ...base, seq: 1, prevHash: null };
    const second = { ...base, seq: 2, action: 'SEALED' as const, prevHash: String(ev.custodyRowHash(first)) };
    const rows = [
      { ...first, rowHash: ev.custodyRowHash(first) },
      { ...second, rowHash: ev.custodyRowHash(second) },
    ];
    expect(ev.verifyCustodyChain(rows)).toEqual({ ok: true, brokenSeq: null });
    const tampered = rows.map((r: any) => ({ ...r }));
    tampered[1].reason = '고친 이유';
    expect(ev.verifyCustodyChain(tampered)).toEqual({ ok: false, brokenSeq: 2 });
    const missing = [rows[0]];
    expect(ev.verifyCustodyChain(missing)).toEqual({ ok: true, brokenSeq: null });
  });

  test('FX-T13 ③ 보존 이유별 파기 시각은 OBJECTION 1년·DISPUTE/INVESTIGATION은 보존 끝 + 30일이다', () => {
    expect(ev.disposeAfterMs({ createdAtMs: NOW, holdReason: 'OBJECTION', holdEndedAtMs: NOW + 30 * DAY })).toBe(NOW + 365 * DAY);
    expect(ev.disposeAfterMs({ createdAtMs: NOW, holdReason: 'DISPUTE', holdEndedAtMs: NOW + 10 * DAY })).toBe(NOW + 40 * DAY);
    expect(ev.disposeAfterMs({ createdAtMs: NOW, holdReason: 'INVESTIGATION', holdEndedAtMs: NOW + 5 * DAY })).toBe(NOW + 35 * DAY);
    expect(() => ev.disposeAfterMs({ createdAtMs: NOW, holdReason: 'INVESTIGATION', holdEndedAtMs: null })).toThrow();
  });

  test('FX-T19 ① [ASVS v5.0.0-5.2.2] 주소는 http·https만 받고 캡처는 확장자·매직 바이트·크기·화소 상한을 함께 본다', () => {
    const png = makePng({ width: 4, height: 4 });
    expect(() => ev.validateExternalPost({ url: 'ftp://example.com/a', source: 'MANUAL', capture: { name: 'a.png', bytes: png } })).toThrow();
    expect(problemStatus(() => ev.validateExternalPost({ url: 'javascript:alert(1)', source: 'MANUAL', capture: { name: 'a.png', bytes: png } }))).toBe(422);
    expect(ev.validateExternalPost({ url: 'https://example.com/post/1', source: 'MANUAL', capture: { name: 'a.png', bytes: png } })).toMatchObject({ site: 'example.com', mediaType: 'image/png', extension: 'png', width: 4, height: 4 });
    expect(problemStatus(() => ev.validateExternalPost({ url: 'https://example.com/post/1', source: 'MANUAL', capture: { name: 'a.jpg', bytes: png } }))).toBe(415);
    expect(problemStatus(() => ev.validateExternalPost({ url: 'https://example.com/post/1', source: 'MANUAL', capture: { name: 'a.pdf', bytes: png } }))).toBe(415);
    expect(problemStatus(() => ev.validateExternalPost({ url: 'https://example.com/post/1', source: 'MANUAL', capture: { name: 'a.png', bytes: makePngOfSize(10 * 1024 * 1024 + 1) } }))).toBe(413);
    expect(ev.validateExternalPost({ url: 'https://example.com/post/1', source: 'MANUAL', capture: { name: 'a.png', bytes: makePngOfSize(10 * 1024 * 1024) } })).toMatchObject({ mediaType: 'image/png' });
    expect(problemStatus(() => ev.validateExternalPost({ url: 'https://example.com/post/1', source: 'MANUAL', capture: { name: 'a.png', bytes: makePngHeader(20_001, 1) } }))).toBe(422);
    expect(ev.validateExternalPost({ url: 'https://example.com/post/1', source: 'MANUAL', capture: { name: 'a.png', bytes: makePngHeader(8_000, 5_000) } })).toMatchObject({ width: 8_000, height: 5_000 });
    expect(problemStatus(() => ev.validateExternalPost({ url: 'https://example.com/post/1', source: 'MANUAL', capture: { name: 'a.png', bytes: makePngHeader(8_001, 5_000) } }))).toBe(422);
    expect(ev.validateExternalPost({ url: 'https://example.com/post/1', source: 'MANUAL', capture: { name: 'a.jpg', bytes: makeJpegWithExif() } })).toMatchObject({ mediaType: 'image/jpeg', extension: 'jpg' });
    expect(problemStatus(() => ev.validateExternalPost({ url: 'https://example.com/post/1', source: 'MANUAL', capture: { name: 'a.gif', bytes: Buffer.from('GIF89a') } }))).toBe(415);
    expect(problemStatus(() => ev.validateExternalPost({ url: 'https://example.com/post/1', source: 'MANUAL', capture: { name: 'a.webp', bytes: Buffer.from('RIFF0000WEBP') } }))).toBe(415);
    expect(ev.validateExternalPost({ url: 'https://example.com/post/1', source: 'MANUAL', capture: { name: 'a.pdf', bytes: makePdf() } })).toMatchObject({ mediaType: 'application/pdf', extension: 'pdf', width: null, height: null });
    expect(ev.maskRegionsValid([{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }])).toBe(true);
    expect(ev.maskRegionsValid([{ x: 1.1, y: 0.1, w: 0.2, h: 0.2 }])).toBe(false);
    expect(ev.maskRegionsValid([{ x: 1, y: 0, w: 0.1, h: 0.1 }])).toBe(false);
    expect(ev.maskRegionsValid(Array.from({ length: 20 }, () => ({ x: 0, y: 0, w: 0.1, h: 0.1 })))).toBe(true);
    expect(ev.maskRegionsValid(Array.from({ length: 21 }, () => ({ x: 0, y: 0, w: 0.1, h: 0.1 })))).toBe(false);
    expect(ev.maskRegionsValid([{ x: 0.1, y: 0.1, w: 0, h: 0.2 }])).toBe(false);
  });

  test('FX-T19 ② 보기용 사본에서 고른 자리를 칠하고 EXIF·XMP를 지운다', async () => {
    const src = makePng({ width: 4, height: 4, text: '연락처 010-0000-0000' });
    const view = await ev.maskCapture({ bytes: src, mediaType: 'image/png', regions: [{ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }] });
    expect(view).toBeInstanceOf(Uint8Array);
    const img = readPng(view);
    expect(img.width).toBe(4);
    expect(img.height).toBe(4);
    expect(img.chunks).not.toContain('tEXt');
    expect(img.chunks).not.toContain('eXIf');
    expect(img.chunks).not.toContain('iTXt');
    expect(img.chunks).not.toContain('iCCP');
    expect(pixelAt(img, 1, 1).slice(0, 3)).toEqual([0, 0, 0]);
    expect(pixelAt(img, 2, 2).slice(0, 3)).toEqual([0, 0, 0]);
    expect(pixelAt(img, 0, 0).slice(0, 3)).not.toEqual([0, 0, 0]);

    const icc = await ev.maskCapture({ bytes: makeIccPng(), mediaType: 'image/png', regions: [] });
    expect(icc).toBeInstanceOf(Uint8Array);
    expect(readPng(icc).chunks).not.toContain('iCCP');
    const many = await ev.maskCapture({ bytes: makePng({ width: 4, height: 4 }), mediaType: 'image/png', regions: Array.from({ length: 20 }, () => ({ x: 0, y: 0, w: 0.1, h: 0.1 })) });
    expect(many).toBeInstanceOf(Uint8Array);
  });

  test('FX-T19 ③ PDF는 보기용 사본을 만들지 않는다', async () => {
    expect(await ev.maskCapture({ bytes: makePdf(), mediaType: 'application/pdf', regions: [] })).toBeUndefined();
    expect(await ev.maskCapture({ bytes: makePdf(), mediaType: 'application/pdf', regions: [{ x: 0, y: 0, w: 0.5, h: 0.5 }] })).toBeUndefined();
  });

  test('FX-T20 ① AUTHORITY 행 고르기는 승인 범위 밖 계정·기간·항목을 빼고 영장 없이 연결·행동·TLS·봇 라벨·의견을 넣지 않는다', () => {
    const inScope = { dataRequestId: id(0x700), eventId: id(0x200), status: 'APPROVED' as const, warrant: false, legalBasis: 'PERFORMANCE_ACT' as const, items: ['PURCHASE', 'ACCESS_LOG', 'POST'] as const, fromMs: NOW - HOUR, toMs: NOW + HOUR, accountIds: [A(1), A(2)] };
    const rows = [
      { table: 'inv_step', accountId: A(1), tsMs: NOW, values: { step: 'SALE', order_id: 'o-1', ticket_id: T(1), payment_method_ref: 'pm-secret', card_bin: '123456', pid: 'pid-secret' } },
      { table: 'inv_request', accountId: A(2), tsMs: NOW, values: { route_kind: 'queue', ip: '203.0.113.9', ja4: 't13d-secret', edge_bot_labels: ['bot'], investigator_opinion: '의견' } },
      { table: 'inv_link', accountId: A(1), tsMs: NOW, values: { kind: 'DEVICE', value: 'device-secret' } },
      { table: 'inv_behavior', accountId: A(1), tsMs: NOW, values: { pointer_entropy: 1.2 } },
      { table: 'inv_step', accountId: A(3), tsMs: NOW, values: { step: 'SALE' } },
      { table: 'inv_step', accountId: A(1), tsMs: NOW + 2 * HOUR, values: { step: 'SALE' } },
    ];
    const out = ev.authoritySelection({ rows, scope: inScope });
    expect(out.selected).toHaveLength(2);
    expect(out.selected.map((r: any) => r.table)).toEqual(['inv_request', 'inv_step']);
    expect(out.selected[0].values).toMatchObject({ ip: '203.0.113.9', route_kind: 'queue' });
    expect(out.selected[0].values).not.toHaveProperty('ja4');
    expect(out.selected[0].values).not.toHaveProperty('edge_bot_labels');
    expect(out.selected[0].values).not.toHaveProperty('investigator_opinion');
    expect(out.selected[1].values).toMatchObject({ step: 'SALE', order_id: 'o-1' });
    expect(out.selected[1].values).not.toHaveProperty('payment_method_ref');
    expect(out.selected[1].values).not.toHaveProperty('card_bin');
    expect(out.selected[1].values).not.toHaveProperty('pid');
    expect(out.excluded).toBe(4);

    const warrant = ev.authoritySelection({ rows, scope: { ...inScope, warrant: true, legalBasis: 'WARRANT' as const } });
    expect(warrant.selected.some((r: any) => r.table === 'inv_link')).toBe(true);
    expect(warrant.selected.some((r: any) => r.table === 'inv_behavior')).toBe(true);
    expect(warrant.selected.find((r: any) => r.table === 'inv_request').values).toMatchObject({ ja4: 't13d-secret', edge_bot_labels: ['bot'] });
  });

  test('FX-T20 ② 기획사 CSV는 5건 미만 칸·2차 가림·수식 삽입 방어를 지킨다', () => {
    const cases = [
      { caseId: id(0x501), reasonCategory: 'MACRO_BOT', status: 'ACTIONED', cancelActionCount: 1, restrictActionCount: 1, cancelledTicketCount: 3, resoldAtFaceValueCount: 3, appealAcceptedCount: 1, appealJudgedCount: 2 },
      { caseId: id(0x502), reasonCategory: 'MACRO_BOT', status: 'ACTIONED', cancelActionCount: 1, restrictActionCount: 0, cancelledTicketCount: 2, resoldAtFaceValueCount: 2, appealAcceptedCount: 1, appealJudgedCount: 1 },
      { caseId: id(0x503), reasonCategory: 'QUEUE_BYPASS', status: 'CLEARED', cancelActionCount: 0, restrictActionCount: 0, cancelledTicketCount: 0, resoldAtFaceValueCount: 0, appealAcceptedCount: 0, appealJudgedCount: 0 },
      { caseId: id(0x504), reasonCategory: 'CAPTCHA_BYPASS', status: 'REVERSED', cancelActionCount: 0, restrictActionCount: 1, cancelledTicketCount: 0, resoldAtFaceValueCount: 0, appealAcceptedCount: 0, appealJudgedCount: 0 },
      { caseId: id(0x505), reasonCategory: 'ACCOUNT_LENDING', status: 'ACTIONED', cancelActionCount: 0, restrictActionCount: 1, cancelledTicketCount: 0, resoldAtFaceValueCount: 0, appealAcceptedCount: 1, appealJudgedCount: 1 },
      { caseId: id(0x506), reasonCategory: 'LIMIT_EVASION', status: 'ACTIONED', cancelActionCount: 0, restrictActionCount: 1, cancelledTicketCount: 0, resoldAtFaceValueCount: 0, appealAcceptedCount: 1, appealJudgedCount: 1 },
    ];
    const csv = ev.promoterCsv({ eventName: '=HYPERLINK("https://evil.example")', cases });
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).not.toContain('0194b240');
    expect(csv).toMatch(/5건 미만/);
    const lines = csv.trim().split(/\r?\n/);
    expect(lines[0]).toBe('metric,value');
    expect(lines[1]!.startsWith("'=")).toBe(true);
    expect(csv).toMatch(/appeal_accepted_ratio,/);
    for (const value of ['+SUM(A1)', '-1', '@cmd', '\tTAB']) {
      const one = ev.promoterCsv({ eventName: value, cases });
      expect(one.split(/\r?\n/)[1]!.startsWith("'")).toBe(true);
    }

    const five = Array.from({ length: 5 }, (_, n) => ({ ...cases[0]!, caseId: id(0x520 + n) }));
    const fiveCsv = ev.promoterCsv({ eventName: '다섯', cases: five });
    expect(fiveCsv).toMatch(/reason_MACRO_BOT,5/);
    const four = five.slice(0, 4);
    const fourCsv = ev.promoterCsv({ eventName: '넷', cases: four });
    expect(fourCsv).not.toMatch(/reason_MACRO_BOT,4/);
    expect(fourCsv).toMatch(/reason_OTHER,5건 미만|reason_MACRO_BOT,5건 미만/);

    // 2차 가림: A 6, B 3, C 1이면 OTHER 4가 가려지고, 합계에서 되살아날 수 있어 다음 칸도 함께 가린다.
    const second = [
      ...Array.from({ length: 6 }, (_, n) => ({ ...cases[0]!, caseId: id(0x530 + n), reasonCategory: 'MACRO_BOT' as const })),
      ...Array.from({ length: 3 }, (_, n) => ({ ...cases[0]!, caseId: id(0x540 + n), reasonCategory: 'QUEUE_BYPASS' as const })),
      { ...cases[0]!, caseId: id(0x550), reasonCategory: 'CAPTCHA_BYPASS' as const },
    ];
    const secondCsv = ev.promoterCsv({ eventName: '이차', cases: second as any });
    expect(secondCsv.match(/5건 미만/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(secondCsv).not.toMatch(/reason_(QUEUE_BYPASS|CAPTCHA_BYPASS),1/);
    expect(secondCsv).toMatch(/appeal_accepted_ratio,0\.5(0)?/);
  });

  test('FX-T20 ③ 고소·고발용 요약은 개인정보 칸 없이 고정 문장과 봉인 해시를 싣는다', () => {
    const caseId = id(0x400);
    const caseRecord = {
      caseId,
      eventId: id(0x200),
      clusterId: id(0x300),
      status: 'ACTIONED',
      reasonCategory: 'MACRO_BOT',
      assigneeId: A(9),
      cancelDeadlineAtMs: NOW,
      appealDueAtMs: null,
      approvalId: null,
      investigatorOpinion: '연락처 010-1111-2222, IP 127.0.0.1, deviceRef d-1',
      outcomeLabel: 'BOT',
      version: 2,
      createdAtMs: NOW - DAY,
      closedAtMs: null,
      members: [{ accountId: A(1), ticketCount: 3, signals: ['LINK_GRAPH'], addedBy: 'SYSTEM', removedAtMs: null, appealResult: 'REJECTED', appealDueAtMs: null, lockExpiresAtMs: null }],
      events: [{ seq: 1, kind: 'NOTE', actorId: A(9), note: 'contactRef c-1 paymentMethodRef pm-1', detail: { ip: '127.0.0.1' }, occurredAtMs: NOW }],
    };
    const cluster = { clusterId: id(0x300), eventId: id(0x200), generation: 1, scoreBand: 'HIGH', accountCount: 2, purchaseCount: 9, limitPerPerson: 4, sharedAttributes: ['PAYMENT_METHOD'], signals: ['LINK_GRAPH'], snapshotVersion: 1, createdAtMs: NOW, members: [] };
    const event = { eventName: '겨울 콘서트', showAtMs: NOW + 7 * DAY, salesOpenedAtMs: NOW - 7 * DAY };
    const posts = [{ postId: id(0x600), url: 'https://example.com/post/1', postedAtMs: NOW - HOUR, captureSha256: 'b'.repeat(64) }];
    const manifestSha256 = 'c'.repeat(64);
    const packet = ev.complaintPacket({ caseRecord, cluster, event, posts, manifestSha256 });
    expect(packet).toMatchObject({
      caseNumber: caseId,
      eventName: '겨울 콘서트',
      showAt: isoOf(NOW + 7 * DAY),
      salesOpenedAt: isoOf(NOW - 7 * DAY),
      reasonCategories: ['MACRO_BOT'],
      purchasedCount: 9,
      limitPerPerson: 4,
      accountCount: 2,
      resaleEvidence: true,
      bundleManifestSha256: manifestSha256,
      statement: '기록을 보존하고 있으며 영장이나 공연법 제4조의3 요청을 받으면 정해진 절차로 냅니다',
    });
    expect(packet.resalePosts).toEqual([{ url: 'https://example.com/post/1', postedAt: isoOf(NOW - HOUR), captureSha256: 'b'.repeat(64) }]);
    const text = JSON.stringify(packet);
    for (const secret of [A(1), '010-1111-2222', '127.0.0.1', 'd-1', 'c-1', 'pm-1', 'PAYMENT_METHOD']) {
      expect(text).not.toContain(secret);
    }
  });

  test('FX-T23 ① 이의 창·이용 제한 풀기·우선 구매 결과의 경계는 같은 순간을 만료로 본다', () => {
    expect(ev.OBJECTION_WINDOW_MS).toBe(30 * DAY);
    expect(ev.disposeAfterMs({ createdAtMs: NOW, holdReason: 'OBJECTION', holdEndedAtMs: NOW + 30 * DAY })).toBe(NOW + 365 * DAY);
    expect(ev.objectionWindowEndMs({ actionNotifiedAtMs: NOW })).toBe(NOW + 30 * DAY);
    expect(ev.objectionWindowEndMs({ actionNotifiedAtMs: null })).toBeNull();
  });

  test('R-T35 ① 우선 구매 결과가 NO_SEAT·ENTRY_STARTED이면 보상 건 대상이다', () => {
    expect(
      ev.objectionCompensationOf([
        { ticketId: T(1), result: 'SAME_SEAT' },
        { ticketId: T(2), result: 'SAME_TIER' },
        { ticketId: T(3), result: 'NO_SEAT' },
        { ticketId: T(4), result: 'ENTRY_STARTED' },
      ]),
    ).toEqual([
      { ticketId: T(3), reason: 'NO_SEAT' },
      { ticketId: T(4), reason: 'ENTRY_STARTED' },
    ]);
    expect(ev.objectionCompensationOf([{ ticketId: T(1), result: 'SAME_SEAT' }])).toEqual([]);
  });

  test('IR-12 기획사 CSV는 사건 기록에서 제한 조치·정가 재판매 수를 센다', () => {
    const events = Array.from({ length: 5 }, (_, n) => ({ kind: 'ACTION_EXECUTED', detail: { action: 'RESTRICT', results: [{ ticketId: T(200 + n), outcome: 'ACCEPTED' }], targets: [{ ticketId: T(200 + n), payerAccountId: A(200 + n) }] } }));
    const csv = ev.promoterCsv({ eventName: '집계', cases: [{ caseId: id(0x560), reasonCategory: 'MACRO_BOT', status: 'ACTIONED', events } as any] });
    expect(csv).toMatch(/restrict_action_count,5/);
    expect(csv).toMatch(/resold_at_face_value_count,5/);
  });

  test('IR-16 보기용 사본은 sharp 화소 상한을 넘는 입력을 거절한다', async () => {
    await expect(ev.maskCapture({ bytes: makePngHeader(20_001, 1), mediaType: 'image/png', regions: [] })).rejects.toMatchObject({ status: 422 });
  });
});

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}
