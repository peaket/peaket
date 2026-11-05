// 관리 계정 비밀번호 저장과 정책(docs/features/identity.md §6 '관리 계정 비밀번호 저장과 정책의 첫 구현', docs/security/auth-controls.md §4·§5, BUILD_ORDER BOT-110).
// 시험: I-T14(길이·맥락·유출·긴 암호문), AC-T6(금칙어 대조 예 아홉), AC-T7 ①②(시험 유출 목록 서버), AC-T10(설정 범위). 메모리 저장소와 로컬 페퍼 키로 본다.
import { createHash } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HibpBreachList, hibpBreachListFromEnv } from '../src/modules/admin/adapters/hibp-breach-list.js';
import { KmsPepper, type PepperMacClient } from '../src/modules/admin/adapters/kms-pepper.js';
import { LocalPepper } from '../src/modules/admin/adapters/local-pepper.js';
import { MemoryAdminAccountStore } from '../src/modules/admin/adapters/memory-admin-account-store.js';
import { Pbkdf2AdminPasswords } from '../src/modules/admin/adapters/pbkdf2-admin-passwords.js';
import { loadPolicyLists } from '../src/modules/admin/adapters/word-list-files.js';
import { AdminPasswordError, PASSWORD_ADVICE, REJECTION_TEXT } from '../src/modules/admin/application/admin-password-error.js';
import { SetAdminPassword } from '../src/modules/admin/application/set-admin-password.js';
import { adminAuthConfigFromEnv, DEFAULT_ADMIN_AUTH_CONFIG } from '../src/modules/admin/domain/auth-config.js';
import { baseCopy, judgePassword, type PasswordContext } from '../src/modules/admin/domain/password-policy.js';
import { PepperUnavailable } from '../src/modules/admin/domain/ports.js';

const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000000a1';
const OTHER = '0190f3a1-7c2e-7a00-8000-0000000000a2';
const pepper = () => new LocalPepper(new Map([[1, Buffer.alloc(32, 8)]]), 1);
const lists = loadPolicyLists({});
const cfg = DEFAULT_ADMIN_AUTH_CONFIG;
/** AC-T6의 가상 파트너: 상호 '해오름엔터', 업무 이메일 minji.kim@haeoreum.example */
const partnerCtx: PasswordContext = { email: 'minji.kim@haeoreum.example', partner: { names: ['해오름엔터'], numbers: [] } };

// 시험 유출 목록 서버(HIBP 범위 조회 흉내): BREACHED에 든 비밀번호의 SHA-1 뒷부분을 돌려주고, 머리를 적어 둔다
const BREACHED = ['correct horse battery staple!', 'thispasswordwasleakedbefore'];
let hibp: { url: string; seen: IncomingHttpHeaders[]; paths: string[]; close: () => Promise<void> };
beforeAll(async () => {
  const seen: IncomingHttpHeaders[] = [];
  const paths: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    paths.push(req.url ?? '');
    // 고장 흉내: 빈 본문, HTML, 답하지 않음(기한 시험)
    if (req.url?.startsWith('/empty/')) return void res.end('');
    if (req.url?.startsWith('/html/')) return void res.end('<html><body>maintenance</body></html>');
    if (req.url?.startsWith('/slow/')) return;
    const prefix = (req.url ?? '').split('/').pop()!.toUpperCase();
    const lines = BREACHED.map((p) => createHash('sha1').update(p.normalize('NFC'), 'utf8').digest('hex').toUpperCase())
      .filter((h) => h.startsWith(prefix))
      .map((h) => `${h.slice(5)}:12`);
    // 채움 줄(횟수 0)
    lines.push('0000000000000000000000000000000000A:0');
    res.end(lines.join('\r\n'));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  hibp = {
    url: `http://127.0.0.1:${port}`,
    seen,
    paths,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
});
afterAll(async () => hibp?.close());

describe('정책 판정(auth-controls §4.3, I-T14, AC-T6)', () => {
  test('AC-T6_금칙어대조예아홉의판정과이유가표와같다', () => {
    const cases: [string, true | string][] = [
      ['Peaket2026!!!!!!', 'CONTEXT'],
      ['p3@k3tp3@k3tp3@k3t', 'CONTEXT'],
      ['vlzpt1234567890!', 'CONTEXT'],
      ['해오름엔터2026!!해오름엔터', 'CONTEXT'],
      ['minji.kim2026!!!', 'CONTEXT'],
      ['qwertyuiop123456', 'COMMON'],
      ['피켓에서일한지삼년째봄날입니다', true],
      ['봄비내리는월요일아침의커피한잔', true],
      ['peaket2026', 'TOO_SHORT'],
    ];
    for (const [pw, want] of cases) {
      const v = judgePassword(pw, partnerCtx, lists, cfg);
      expect([pw, v.ok ? true : v.reason]).toEqual([pw, want]);
    }
  });

  test('I-T14_15자미만은TOO_SHORT_64자넘는긴암호문은받고_256자를넘으면TOO_LONG이며_꼴규칙은COMMON이다', () => {
    const ctx: PasswordContext = { email: 'ops@peaket.example' };
    expect(judgePassword('짧은비밀번호입니다', ctx, lists, cfg)).toEqual({ ok: false, reason: 'TOO_SHORT' });
    const long = '서로 관계없는 낱말을 이어 붙인 아주 긴 문장은 비밀번호 관리자 없이도 기억하기 쉽고 충분히 강하다 2026 그리고 조금 더 길게 이어 쓴다'.repeat(1);
    expect(long.length).toBeGreaterThan(64);
    expect(judgePassword(long, ctx, lists, cfg)).toEqual({ ok: true });
    expect(judgePassword('가'.repeat(257), ctx, lists, cfg)).toEqual({ ok: false, reason: 'TOO_LONG' });
    expect(judgePassword('aaaaaaaaaaaaaaaa', ctx, lists, cfg)).toEqual({ ok: false, reason: 'COMMON' });
    expect(judgePassword('ㅂㅈㄷㄱㅅㅛㅕㅑㅐㅔ1234567', ctx, lists, cfg)).toEqual({ ok: false, reason: 'COMMON' });
    expect(judgePassword('9876543210987654', ctx, lists, cfg)).toEqual({ ok: false, reason: 'COMMON' });
    // 흔한 목록 파일에 든 것
    expect(lists.common.size).toBeGreaterThan(0);
    const listed = 'football12345678';
    expect(judgePassword(listed, ctx, lists, cfg)).toEqual({ ok: false, reason: 'COMMON' });
    // 맥락 말이 들어 있기만 한 긴 문장은 받는다
    expect(judgePassword('administrator라는말이들어간긴문장입니다아주길게', ctx, lists, cfg)).toEqual({ ok: true });
  });

  // 새 맥락 리뷰(2026-11-05) 재현: 바꿈 사본에서 덧붙인 날짜 숫자가 글자로 세어지면 안 된다(§4.3 4 '숫자이므로 같다')
  test('I-T14_바꿈사본에서맥락말을지운뒤남은날짜숫자는글자로세지않는다', () => {
    const ctx: PasswordContext = { email: 'ops@peaket.example' };
    expect(judgePassword('p@ssw0rd20250531!', ctx, lists, cfg)).toEqual({ ok: false, reason: 'CONTEXT' });
    expect(judgePassword('P3@k3t20240526!!', ctx, lists, cfg)).toEqual({ ok: false, reason: 'CONTEXT' });
    // 아랍 숫자 같은 다른 숫자 글자도 숫자다
    expect(judgePassword('Peaket٢٠٢٦٢٠٢٦!!', ctx, lists, cfg)).toEqual({ ok: false, reason: 'CONTEXT' });
  });

  test('I-T14_꼴규칙조각은앞에서가장긴것만이아니라어떻게나눠도모두조각이면막는다', () => {
    const ctx: PasswordContext = { email: 'ops@peaket.example' };
    expect(judgePassword('qwertyuiopppasdf', ctx, lists, cfg)).toEqual({ ok: false, reason: 'COMMON' });
    expect(judgePassword('qwerrrasdfzxcvbn', ctx, lists, cfg)).toEqual({ ok: false, reason: 'COMMON' });
    // 조각이 아닌 글자가 끼면 꼴 규칙으로는 막지 않는다
    expect(judgePassword('qwertyuiopxqasdfgh', ctx, lists, cfg)).toEqual({ ok: true });
  });

  // 재리뷰(2026-11-05) 재현: 바꿈 꼴로 숨긴 키보드 줄도 꼴 규칙이다(전체 판정과 맥락 말을 지운 나머지 모두)
  test('I-T14_바꿈꼴로숨긴키보드줄과반복은꼴규칙으로막는다', () => {
    const ctx: PasswordContext = { email: 'ops@peaket.example' };
    for (const pw of ['qw3rtyuiopasdfgh', 'aaaaaaa4aaaaaaaa']) expect([pw, judgePassword(pw, ctx, lists, cfg)]).toEqual([pw, { ok: false, reason: 'COMMON' }]);
    for (const pw of ['Peaket!!!qw3rtyuiop', 'Peaket!!qw3rtyqw3rty', 'p@ssw0rd!!!qw3rtyuiop']) expect([pw, judgePassword(pw, ctx, lists, cfg)]).toEqual([pw, { ok: false, reason: 'CONTEXT' }]);
  });

  test('I-T14_흔한목록은바꿈꼴로도대조한다', () => {
    expect(judgePassword('f00tball12345678', { email: 'ops@peaket.example' }, lists, cfg)).toEqual({ ok: false, reason: 'COMMON' });
  });

  test('[ASVS v5.0.0-6.1.2]_서비스맥락말은목록파일에서읽고_배포가더한파일의말도막는다', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    expect(lists.serviceWords).toContain('peaket');
    const dir = mkdtempSync(join(tmpdir(), 'peaket-l3-'));
    const extra = join(dir, 'extra.txt');
    writeFileSync(extra, '# 운영 도메인\nopsdomainexample\n');
    const withExtra = loadPolicyLists({ PEAKET_AUTH_CONTEXT_WORDS_FILE: extra });
    expect(judgePassword('opsdomainexample2026!!', { email: 'ops@peaket.example' }, withExtra, cfg)).toEqual({ ok: false, reason: 'CONTEXT' });
    expect(judgePassword('opsdomainexample2026!!', { email: 'ops@peaket.example' }, lists, cfg)).toEqual({ ok: true });
    expect(() => loadPolicyLists({ PEAKET_AUTH_CONTEXT_WORDS_FILE: join(dir, 'none.txt') })).toThrow(/PEAKET_AUTH_CONTEXT_WORDS_FILE/);
  });

  test('AC-T6_거절이유문구넷과안내문구가정본과같다', () => {
    expect(REJECTION_TEXT).toMatchObject({
      COMMON: '너무 흔한 비밀번호입니다',
      BREACHED: '유출된 적이 있는 비밀번호입니다',
      CONTEXT: '서비스·회사·계정 이름에 숫자나 기호만 붙인 비밀번호는 쓸 수 없습니다',
      TOO_SHORT: '15자 이상이어야 합니다',
    });
    expect(PASSWORD_ADVICE).toBe('서로 관계없는 낱말 여러 개를 이은 문장이나 비밀번호 관리자가 만든 값을 쓰세요');
  });
});

describe('저장 문자열(PBKDF2 + KMS 페퍼)', () => {
  test('PHC는pbkdf2-sha256과반복횟수·페퍼판을싣고_같은원문(NFC)만맞으며_다른계정ID로는맞지않는다', async () => {
    const pw = new Pbkdf2AdminPasswords(pepper(), { iterations: 1_000 });
    const phc = await pw.hash(ACCOUNT, '피켓에서일한지삼년째봄날입니다');
    expect(phc).toMatch(/^\$pbkdf2-sha256\$i=1000,k=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(await pw.verify(ACCOUNT, '피켓에서일한지삼년째봄날입니다', phc)).toBe(true);
    // 같은 글자를 NFD로 줘도 NFC로 맞춰 같다
    expect(await pw.verify(ACCOUNT, '피켓에서일한지삼년째봄날입니다'.normalize('NFD'), phc)).toBe(true);
    expect(await pw.verify(ACCOUNT, '피켓에서일한지삼년째봄날입니다!', phc)).toBe(false);
    expect(await pw.verify(OTHER, '피켓에서일한지삼년째봄날입니다', phc)).toBe(false);
    // 반복 횟수가 기준보다 적거나 쓰기 판이 아니면 다시 저장해야 한다
    expect(new Pbkdf2AdminPasswords(pepper(), { iterations: 600_000 }).needsRehash(phc)).toBe(true);
    expect(pw.needsRehash(phc)).toBe(false);
    const two = new Pbkdf2AdminPasswords(new LocalPepper(new Map([[1, Buffer.alloc(32, 8)], [2, Buffer.alloc(32, 9)]]), 2), { iterations: 1_000 });
    expect(two.needsRehash(phc)).toBe(true);
    expect(await two.verify(ACCOUNT, '피켓에서일한지삼년째봄날입니다', phc)).toBe(true);
    // 모르는 판·꼴은 맞지 않는다(던지지 않는다)
    expect(await pw.verify(ACCOUNT, 'x', '$pbkdf2-sha256$i=1000,k=9$AAAA$BBBB')).toBe(false);
    expect(await pw.verify(ACCOUNT, 'x', 'garbage')).toBe(false);
  });

  // 새 맥락 리뷰(2026-11-05) 재현: 반복 횟수에 위 끝이 없으면 pbkdf2가 던지거나 스레드풀을 오래 붙잡는다
  test('반복횟수가범위밖이거나계정ID가UUID가아니면던지지않고맞지않는다', async () => {
    const pw = new Pbkdf2AdminPasswords(pepper(), { iterations: 1_000 });
    const phc = await pw.hash(ACCOUNT, '피켓에서일한지삼년째봄날입니다');
    const [, , , salt, mac] = phc.split('$');
    for (const i of ['99999999999', '10000001', '0']) {
      const bad = `$pbkdf2-sha256$i=${i},k=1$${salt}$${mac}`;
      expect(await pw.verify(ACCOUNT, '피켓에서일한지삼년째봄날입니다', bad)).toBe(false);
      expect(pw.needsRehash(bad)).toBe(true);
    }
    expect(await pw.verify('not-a-uuid', '피켓에서일한지삼년째봄날입니다', phc)).toBe(false);
  });

  test('KMS페퍼오류는원인으로오류이름만싣고_같은키를ARN과키ID로섞어주면거절한다', async () => {
    const leaky: PepperMacClient = {
      mac: async () => {
        throw Object.assign(new Error('arn:aws:kms:ap-northeast-2:111122223333:key/secret-detail'), { name: 'AccessDeniedException' });
      },
      verify: async () => true,
    };
    const e = await new KmsPepper(leaky, new Map([[1, 'k1']]), 1).mac(1, Buffer.alloc(1)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PepperUnavailable);
    expect((e as Error).cause).toBe('AccessDeniedException');
    expect(JSON.stringify({ e, c: String((e as Error).cause) })).not.toContain('secret-detail');
    const id = '1234abcd-12ab-34cd-56ef-1234567890ab';
    expect(() => new KmsPepper(leaky, new Map([[1, id], [2, `arn:aws:kms:ap-northeast-2:111122223333:key/${id}`]]), 2)).toThrow(/다른 KMS 키/);
  });

  test('기본반복횟수는600000회다', async () => {
    const phc = await new Pbkdf2AdminPasswords(pepper()).hash(ACCOUNT, '봄비내리는월요일아침의커피한잔');
    expect(phc.startsWith('$pbkdf2-sha256$i=600000,k=1$')).toBe(true);
  });
});

describe('비밀번호 정하기(AC-T7 ①②)', () => {
  async function setup(url = hibp.url) {
    const clock = fakeClock({ now: Date.parse('2026-11-05T00:00:00Z') });
    const store = new MemoryAdminAccountStore();
    store.create({ id: ACCOUNT, role: 'partner_admin', email: 'minji.kim@haeoreum.example', status: 'INVITED', now: clock.now() });
    const set = new SetAdminPassword(store, new Pbkdf2AdminPasswords(pepper(), { iterations: 1_000 }), new HibpBreachList({ baseUrl: url, timeoutMs: 500 }), lists, cfg, clock);
    return { clock, store, set };
  }

  test('AC-T7①_유출목록에있으면BREACHED로거절하고저장하지않으며_요청은앞5자와Add-Padding만보낸다', async () => {
    const t = await setup();
    const e = await t.set.run({ accountId: ACCOUNT, password: 'correct horse battery staple!', partner: partnerCtx.partner }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AdminPasswordError);
    expect(e).toMatchObject({ code: 'REJECTED', reason: 'BREACHED' });
    expect(t.store.peek(ACCOUNT)?.passwordPhc).toBeNull();
    const last = hibp.paths.at(-1)!;
    expect(last).toMatch(/^\/range\/[0-9A-F]{5}$/);
    expect(hibp.seen.at(-1)!['add-padding']).toBe('true');
    // 받은 비밀번호는 원문(NFC)으로 저장되고, 대조 시각을 남긴다
    await t.set.run({ accountId: ACCOUNT, password: '피켓에서일한지삼년째봄날입니다', partner: partnerCtx.partner });
    expect(t.store.peek(ACCOUNT)?.passwordPhc).toMatch(/^\$pbkdf2-sha256\$/);
    expect(t.store.peek(ACCOUNT)?.breachCheckedAt).toBe(t.clock.now());
  });

  test('AC-T7②_유출목록에닿지못하면UNAVAILABLE이고비밀번호를저장하지않는다_정책에걸리면목록을부르지않는다', async () => {
    const t = await setup('http://127.0.0.1:9');
    const e = await t.set.run({ accountId: ACCOUNT, password: '봄비내리는월요일아침의커피한잔', partner: partnerCtx.partner }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'UNAVAILABLE' });
    expect(t.store.peek(ACCOUNT)?.passwordPhc).toBeNull();
    const before = hibp.paths.length;
    const ok = await setup();
    const r = await ok.set.run({ accountId: ACCOUNT, password: 'Peaket2026!!!!!!', partner: partnerCtx.partner }).catch((x: unknown) => x);
    expect(r).toMatchObject({ code: 'REJECTED', reason: 'CONTEXT' });
    expect(hibp.paths.length).toBe(before);
  });

  // 새 맥락 리뷰(2026-11-05) 재현: 정상 응답에는 채움 줄이 반드시 있으므로, 빈 본문·HTML은 '유출 없음'이 아니라 닿지 못함이다
  test('AC-T7②_유출목록응답이비었거나목록꼴이아니거나기한을넘기면UNAVAILABLE이고_오류에앞5자와SHA-1이없다', async () => {
    const pw = '봄비내리는월요일아침의커피한잔';
    const sha1 = createHash('sha1').update(pw, 'utf8').digest('hex').toUpperCase();
    for (const path of ['/empty', '/html', '/slow']) {
      const list = new HibpBreachList({ baseUrl: `${hibp.url}${path}`, timeoutMs: 300 });
      const e = await list.isBreached(pw).catch((x: unknown) => x);
      expect([path, (e as Error).name]).toEqual([path, 'BreachListUnavailable']);
      const shown = JSON.stringify({ m: (e as Error).message, c: String((e as Error).cause), s: (e as Error).stack });
      expect(shown).not.toContain(sha1.slice(0, 5));
      expect(shown).not.toContain(sha1.slice(5));
    }
  });

  test('PEAKET_HIBP_URL로유출목록주소를바꾸고_설정의기한을쓴다', async () => {
    const list = hibpBreachListFromEnv({ PEAKET_HIBP_URL: hibp.url, PEAKET_ENV: 'local' }, { ...cfg, breachTimeoutMs: 700 });
    expect(await list.isBreached('correct horse battery staple!')).toBe(true);
    expect(() => hibpBreachListFromEnv({ PEAKET_HIBP_URL: 'http://hibp.internal.example', PEAKET_ENV: 'prod' }, cfg)).toThrow(/https/);
    expect(() => hibpBreachListFromEnv({ PEAKET_HIBP_URL: 'https://exa mple', PEAKET_ENV: 'prod' }, cfg)).toThrow(/주소 꼴/);
  });

  // 새 맥락 리뷰(2026-11-05) 재현: L5(이메일·표시 이름)는 부르는 쪽이 넘긴 값이 아니라 admin_account 행에서 만든다
  test('AC-T6_계정맥락말은저장소의업무이메일·표시이름으로만들고_부르는쪽은파트너맥락만넘긴다', async () => {
    const t = await setup();
    t.store.create({ id: OTHER, role: 'operator', email: 'Jisoo.Park@peaket.example', displayName: '박지수매니저', status: 'INVITED', now: t.clock.now() });
    for (const pw of ['jisoo.park2026!!', '박지수매니저2026!!!!!!!']) {
      const e = await t.set.run({ accountId: OTHER, password: pw }).catch((x: unknown) => x);
      expect([pw, e]).toMatchObject([pw, { code: 'REJECTED', reason: 'CONTEXT' }]);
    }
  });

  test('AC-T6_받은비밀번호는대조사본이아니라원문(NFC)으로해시되어원문으로만맞는다', async () => {
    const t = await setup();
    const raw = 'Spring Rain Monday 커피 한잔 With Friends';
    expect(baseCopy(raw)).not.toBe(raw);
    await t.set.run({ accountId: ACCOUNT, password: raw, partner: partnerCtx.partner });
    const phc = t.store.peek(ACCOUNT)!.passwordPhc!;
    const pw = new Pbkdf2AdminPasswords(pepper(), { iterations: 1_000 });
    expect(await pw.verify(ACCOUNT, raw, phc)).toBe(true);
    expect(await pw.verify(ACCOUNT, baseCopy(raw), phc)).toBe(false);
    expect(await pw.verify(ACCOUNT, raw.toLowerCase(), phc)).toBe(false);
  });

  test('삭제한계정에는비밀번호를쓰지않는다(읽은뒤삭제되어도)', async () => {
    const t = await setup();
    t.store.create({ id: OTHER, role: 'cs_agent', email: 'gone@peaket.example', status: 'REMOVED', now: t.clock.now() });
    expect(await t.store.setPassword({ id: OTHER, phc: '$pbkdf2-sha256$i=1,k=1$AA$BB', breachCheckedAt: 0, now: 0 })).toBe(false);
    expect(t.store.peek(OTHER)?.passwordPhc).toBeNull();
    // 정하기 도중(행을 읽은 뒤 해시하는 사이) 삭제되면 NOT_FOUND이고 쓰지 않는다
    const store = new MemoryAdminAccountStore();
    store.create({ id: ACCOUNT, role: 'operator', email: 'race@peaket.example', now: t.clock.now() });
    const racing = Object.assign(Object.create(store) as MemoryAdminAccountStore, {
      get: async (id: string) => {
        const row = await store.get(id);
        store.remove(id);
        return row;
      },
      setPassword: (i: Parameters<MemoryAdminAccountStore['setPassword']>[0]) => store.setPassword(i),
    });
    const set = new SetAdminPassword(racing, new Pbkdf2AdminPasswords(pepper(), { iterations: 1_000 }), { isBreached: async () => false }, lists, cfg, t.clock);
    await expect(set.run({ accountId: ACCOUNT, password: '봄비내리는월요일아침의커피한잔' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(store.peek(ACCOUNT)?.passwordPhc).toBeNull();
  });
});

describe('설정 범위 검사(AC-T10)', () => {
  test('AC-T10_잠금기준20·누계상한150·최소길이12는시작에실패하고어느설정인지알린다_기본값과시간표기는받는다', () => {
    expect(() => adminAuthConfigFromEnv({ PEAKET_AUTH_ADMIN_LOGIN_LOCK_AFTER_FAILURES: '20' })).toThrow(/admin_login\.lock_after_failures/);
    expect(() => adminAuthConfigFromEnv({ PEAKET_AUTH_ADMIN_LOGIN_PASSWORD_FAILURE_CAP: '150' })).toThrow(/admin_login\.password_failure_cap/);
    expect(() => adminAuthConfigFromEnv({ PEAKET_AUTH_PASSWORD_MIN_LENGTH: '12' })).toThrow(/password\.min_length/);
    expect(() => adminAuthConfigFromEnv({ PEAKET_AUTH_ADMIN_LOGIN_TIMED_LOCK_FIRST: '2h' })).toThrow(/admin_login\.timed_lock_first/);
    expect(() => adminAuthConfigFromEnv({ PEAKET_AUTH_ADMIN_LOGIN_PASSWORD_FAILURE_NOTICE: '120' })).toThrow(/admin_login\.password_failure_notice/);
    expect(adminAuthConfigFromEnv({})).toEqual(DEFAULT_ADMIN_AUTH_CONFIG);
    expect(adminAuthConfigFromEnv({ PEAKET_AUTH_ADMIN_LOGIN_TIMED_LOCK_FIRST: '30m', PEAKET_AUTH_PASSWORD_BREACH_TIMEOUT: '1.5s' })).toMatchObject({ timedLockFirstMs: 30 * 60_000, breachTimeoutMs: 1_500 });
  });

  test('AC-T10_모르는PEAKET_AUTH_설정이름은오타로보고시작하지않는다_목록파일설정은받는다', () => {
    expect(() => adminAuthConfigFromEnv({ PEAKET_AUTH_ADMIN_LOGIN_LOCK_AFTER_FAILUERS: '5' })).toThrow(/PEAKET_AUTH_ADMIN_LOGIN_LOCK_AFTER_FAILUERS/);
    expect(adminAuthConfigFromEnv({ PEAKET_AUTH_CONTEXT_WORDS_FILE: '/etc/peaket/context-words.txt' })).toEqual(DEFAULT_ADMIN_AUTH_CONFIG);
  });
});
