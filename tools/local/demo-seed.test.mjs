// BAT-087 기본 합성 시드(DS-05), 부트스트랩 가드·멱등(DS-06), 시드의 비밀·개인정보 없음(DS-12)을 본다.
// 정본: docs/review/plans/BAT-087.md §5 '시드 파일 계약', §6 DS-05·06·12, §9 M6·M7·M11.
// DS-06은 가짜 pg 모듈(메모리 대신 JSON 파일)로 부트스트랩 스크립트를 두 번 돌린다 — 실제 DB·클러스터는 쓰지 않는다.
// 실행(저장소 뿌리): node --test "tools/local/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';
import { checkSeed, matchSeedEvents, resolveSeedTimes, seatCountsOf } from './demo-seed.mjs';
import { DEMO_SEED_FILE, readSeed } from './demo-auth.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IDENTITY_SEED = join(REPO, 'services', 'identity-svc', 'scripts', 'seed-demo.mjs');
const CORE_SEED = join(REPO, 'services', 'core-svc', 'scripts', 'seed-demo.mjs');
const ADMIN_KEYS = ['sujin', 'minho', 'seoyeon', 'daeun', 'jun', 'second-commander', 'stella-admin'];
const FAN_KEYS = ['jimin', 'haneul', 'doyun', 'newbie'];
const PASSKEY_KEYS = ['sujin', 'second-commander', 'stella-admin'];

const seed = () => readSeed(DEMO_SEED_FILE);
const run = (file, args, env = {}) => spawnSync(process.execPath, [file, ...args], { cwd: REPO, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...env } });
const stateOf = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { accounts: {}, passkeys: {}, promoters: {}, writes: 0 });

/** 가짜 pg·모듈 가로채기 파일을 임시 폴더에 만든다 */
function fakePgDir() {
  const dir = mkdtempSync(join(tmpdir(), 'peaket-bat087-seed-'));
  const pg = `import { existsSync as exists, readFileSync as read, writeFileSync as write } from 'node:fs';
const path = process.env.PEAKET_FAKE_PG_STATE;
const load = () => (exists(path) ? JSON.parse(read(path, 'utf8')) : { accounts: {}, passkeys: {}, promoters: {}, writes: 0 });
const save = (s) => write(path, JSON.stringify(s, null, 2));
const key = (v) => (Buffer.isBuffer(v) ? v.toString('hex') : String(v));
export class Client {
  async connect() {}
  async end() {}
  async query(sql, params = []) {
    const s = load();
    const text = String(sql);
    let rowCount = 0;
    if (/select id from admin_account/i.test(text)) {
      const [id, email, removed] = params;
      rowCount = s.accounts[key(id)] || Object.values(s.accounts).some((a) => a.email === email && a.status !== removed) ? 1 : 0;
    } else if (/insert into admin_account/i.test(text)) {
      const [id, role, promoterId, status, email, displayName, passwordPhc, totpEnc] = params;
      if (!s.accounts[key(id)]) {
        s.accounts[key(id)] = { role, promoterId, status, email, displayName, hasPhc: Boolean(passwordPhc), hasTotp: Boolean(totpEnc) };
        s.writes += 1;
        rowCount = 1;
      }
    } else if (/select 1 from admin_passkey/i.test(text)) {
      rowCount = s.passkeys[key(params[0])] ? 1 : 0;
    } else if (/insert into admin_passkey/i.test(text)) {
      const [adminId, credentialId] = params;
      const k = key(credentialId);
      if (!s.passkeys[k]) {
        s.passkeys[k] = { adminId };
        s.writes += 1;
        rowCount = 1;
      }
    } else if (/select 1 from promoter/i.test(text)) {
      rowCount = s.promoters[key(params[0])] ? 1 : 0;
    } else if (/insert into promoter/i.test(text)) {
      const [id, legalName] = params;
      if (!s.promoters[key(id)]) {
        s.promoters[key(id)] = { legalName };
        s.writes += 1;
        rowCount = 1;
      }
    }
    save(s);
    return { rowCount, rows: rowCount ? [{}] : [] };
  }
}
export default { Client };
`;
  const hook = `import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const dir = process.env.PEAKET_FAKE_DIR;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'pg') return { url: pathToFileURL(join(dir, 'fake-pg.mjs')).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
`;
  writeFileSync(join(dir, 'fake-pg.mjs'), pg);
  writeFileSync(join(dir, 'hook.mjs'), hook);
  return dir;
}

/** 부트스트랩 JSON 하나(가짜 계정 1·패스키 1·promoter 1). 값은 이 파일에만 있고 저장소에는 쓰지 않는다 */
function bootstrapFile(dir) {
  const file = join(dir, 'bootstrap.json');
  writeFileSync(
    file,
    `${JSON.stringify({
      version: 1,
      seedFile: 'deploy/envs/demo/seed/base.yaml',
      promoters: [{ key: 'stella', id: '11111111-1111-4111-8111-111111111111', legalName: '예시 주식회사' }],
      accounts: [
        {
          key: 'sujin',
          id: '22222222-2222-4222-8222-222222222222',
          email: 'sujin@peaket.test',
          displayName: '수진',
          role: 'commander',
          password: 'correct-horse-battery-staple',
          totpSeed: 'JBSWY3DPEHPK3PXP',
          passkeys: [{ name: '수진 패스키', credentialId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', publicKeyCose: 'pAEBAycgBiFYIJVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=', aaguid: '33333333-3333-4333-8333-333333333333' }],
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  return file;
}

const bootstrapEnv = (dir, state, extra = {}) => ({
  PEAKET_ENV: 'local',
  PEAKET_DEMO_BOOTSTRAP_FILE: join(dir, 'bootstrap.json'),
  PEAKET_FAKE_DIR: dir,
  PEAKET_FAKE_PG_STATE: state,
  PEAKET_DATABASE_URL: 'postgres://fake/fake',
  PEAKET_BOOTSTRAP_DATABASE_URL: 'postgres://fake/fake',
  PEAKET_ADMIN_PEPPER_KEY: Buffer.alloc(32, 1).toString('base64'),
  PEAKET_ADMIN_TOTP_KEY: Buffer.alloc(32, 2).toString('base64'),
  ...extra,
});

test('DS-05 시드 참조가 맞고 개수가 계획·d5 §10.3과 같다', () => {
  const result = checkSeed();
  assert.equal(result.ok, true, `시드 검사 실패: ${result.problems.join('; ')}`);
  assert.deepEqual(result.counts, {
    accounts: 11,
    fans: 4,
    admins: 7,
    passkeys: 3,
    promoters: 1,
    productions: 4,
    events: 7,
    seatMaps: 7,
    seats: 2400,
    wheelchairSeats: 20,
    staff: 2,
    devices: 7,
  });
  const s = seed();
  assert.deepEqual(s.accounts.filter((a) => a.kind === 'fan').map((a) => a.key), FAN_KEYS, '팬 계정');
  assert.deepEqual(s.accounts.filter((a) => a.kind === 'admin').map((a) => a.key), ADMIN_KEYS, '관리 계정');
  assert.deepEqual((s.adminPasskeys ?? []).map((p) => p.accountKey), PASSKEY_KEYS, '패스키 계정');
  assert.deepEqual(s.productions.map((p) => p.key), ['e1', 'e2', 'e3', 'e4'], '공연');
  assert.deepEqual(s.events.map((e) => e.key), ['e1-1025', 'e1-1026', 'e2-01', 'e3-01', 'e3-02', 'e3-03', 'e4-01'], '회차');
  assert.deepEqual(seatCountsOf(s), { seats: 2400, wheelchair: 20 }, '좌석 수');
  // d5 §10.3의 기기 일곱(동문 4·서문 3). 시드 주석과 실제 값이 같아야 한다(RV-06)
  assert.deepEqual(
    s.staff.flatMap((st) => (st.devices ?? []).map((d) => d.name)),
    ['동문-01', '동문-02', '동문-03', '동문-04', '서문-01', '서문-02', '서문-03'],
    '기기 일곱 대',
  );
});

test('RV-01 회차 오픈은 실행 시각 기준 상대 표기이고 지난 시각은 실패한다', () => {
  const s = seed();
  for (const e of s.events) assert.match(String(e.openAt), /^[+-]\d+[mhd]$/, `회차 ${e.key}의 openAt이 상대 표기가 아니다(${e.openAt})`);
  // 상대 표기를 지금 기준으로 펼치면 모두 미래이고, 판매 종료(시작 24시간 전)보다 이르다
  const resolved = resolveSeedTimes(s);
  for (const e of resolved.events) {
    assert.ok(Date.parse(e.openAt) > Date.now(), `${e.key}의 openAt이 지났다(${e.openAt})`);
    assert.ok(Date.parse(e.openAt) < Date.parse(e.startAt) - 24 * 60 * 60_000, `${e.key}의 openAt이 판매 종료보다 늦다`);
  }
  assert.equal(checkSeed().ok, true, '지금 기준으로 시드 검사가 실패했다');

  const dir = mkdtempSync(join(tmpdir(), 'peaket-bat087-time-'));
  const write = (name, value) => {
    const file = join(dir, name);
    writeFileSync(file, stringifyYaml(value));
    return file;
  };
  const past = structuredClone(s);
  past.events[0].openAt = '-1h';
  const pastResult = checkSeed(write('past.yaml', past));
  assert.equal(pastResult.ok, false, '지난 openAt(-1h)이 통과했다');
  assert.ok(pastResult.problems.some((p) => p.includes('openAt') && /지났|지난/.test(p)), `지난 시각 문제가 없다: ${pastResult.problems.join('; ')}`);

  const oldAbsolute = structuredClone(s);
  oldAbsolute.events[0].openAt = '2020-01-01T00:00:00+09:00';
  const oldResult = checkSeed(write('old-absolute.yaml', oldAbsolute));
  assert.equal(oldResult.ok, false, '지난 절대 시각이 통과했다');

  const garbage = structuredClone(s);
  garbage.events[0].openAt = 'tomorrow';
  const badResult = checkSeed(write('bad-time.yaml', garbage));
  assert.equal(badResult.ok, false, '읽지 못하는 시각 표기가 통과했다');
  assert.ok(badResult.problems.some((p) => p.includes('openAt')), `읽지 못하는 openAt 문제가 없다: ${badResult.problems.join('; ')}`);
});

test('RV-01 잔여 절대 시각: startAt·endAt·entryOpensAt도 상대 표기이고 순서·경계를 검사한다', () => {
  const s = seed();
  // 절대 날짜가 하나라도 남으면 시드가 늙는다(--check가 먼저 실패해야 한다)
  const text = readFileSync(DEMO_SEED_FILE, 'utf8');
  assert.ok(!/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text), '시드 파일에 절대 날짜가 남아 있다');
  const relative = /^[+-](?:\d+d)?(?:\d+h)?(?:\d+m)?$/;
  for (const e of s.events) {
    for (const field of ['openAt', 'startAt', 'endAt', 'entryOpensAt']) {
      assert.match(String(e[field]), relative, `회차 ${e.key}의 ${field}가 상대 표기가 아니다(${e[field]})`);
    }
  }

  // 회차 길이(종료 − 시작)는 공연 길이 그대로다: 상대 표기로 바꿔도 값의 뜻이 남는다
  const resolved = resolveSeedTimes(s);
  const minutesOf = (key) => {
    const e = resolved.events.find((x) => x.key === key);
    return (Date.parse(e.endAt) - Date.parse(e.startAt)) / 60_000;
  };
  assert.equal(minutesOf('e1-1025'), 120, 'LUMEN 콘서트 회차 길이');
  assert.equal(minutesOf('e2-01'), 180, '가을 야외 페스티벌 회차 길이');
  assert.equal(minutesOf('e3-01'), 100, '소극장 뮤지컬 회차 길이');
  assert.equal(minutesOf('e4-01'), 90, '팬미팅 회차 길이');

  const dir = mkdtempSync(join(tmpdir(), 'peaket-bat087-times-'));
  const write = (name, value) => {
    const file = join(dir, name);
    writeFileSync(file, stringifyYaml(value));
    return file;
  };
  let seq = 0;
  const check = (mutate) => {
    const copy = structuredClone(s);
    mutate(copy.events);
    seq += 1;
    return checkSeed(write(`mutated-${seq}.yaml`, copy));
  };

  // 절대 시각이 남은 자리마다 실패한다(미래의 절대값도 통과하지 않는다)
  for (const field of ['openAt', 'startAt', 'endAt', 'entryOpensAt']) {
    const r = check((events) => {
      events[0][field] = '2026-12-24T18:00:00+09:00';
    });
    assert.equal(r.ok, false, `절대 시각 ${field}가 통과했다`);
    assert.ok(
      r.problems.some((p) => p.includes(field) && p.includes('절대')),
      `${field} 절대 시각 문제가 없다: ${r.problems.join('; ')}`,
    );
  }

  // 과거 시각은 실패한다
  const pastOpen = check((events) => {
    events[0].openAt = '-1h';
  });
  assert.equal(pastOpen.ok, false, '지난 openAt(-1h)이 통과했다');
  assert.ok(pastOpen.problems.some((p) => p.includes('openAt') && /지났|지난/.test(p)), `지난 시각 문제가 없다: ${pastOpen.problems.join('; ')}`);

  // 순서 위반: 시작 ≥ 종료, 입장 시작 > 시작, 오픈 ≥ 판매 종료(시작 24시간 전)
  const sameEnd = check((events) => {
    events[0].endAt = events[0].startAt;
  });
  assert.equal(sameEnd.ok, false, 'startAt == endAt이 통과했다');
  assert.ok(sameEnd.problems.some((p) => p.includes('endAt')), `startAt/endAt 순서 문제가 없다: ${sameEnd.problems.join('; ')}`);

  const reversedEnd = check((events) => {
    events[0].endAt = '+1d5h';
  });
  assert.equal(reversedEnd.ok, false, 'endAt < startAt이 통과했다');

  const lateEntry = check((events) => {
    events[0].entryOpensAt = '+1d7h';
  });
  assert.equal(lateEntry.ok, false, 'entryOpensAt > startAt이 통과했다');
  assert.ok(lateEntry.problems.some((p) => p.includes('entryOpensAt')), `entryOpensAt 문제가 없다: ${lateEntry.problems.join('; ')}`);

  const saleEndAtOpen = check((events) => {
    events[0].openAt = '+6h'; // e1-1025의 시작(+1d6h) 24시간 전과 같은 시각
  });
  assert.equal(saleEndAtOpen.ok, false, 'openAt == 판매 종료가 통과했다');
  assert.ok(saleEndAtOpen.problems.some((p) => p.includes('openAt') && p.includes('판매 종료')), `판매 종료 경계 문제가 없다: ${saleEndAtOpen.problems.join('; ')}`);

  // 경계는 양 끝에서 갈린다: 입장 시작 == 시작은 되고, 오픈은 판매 종료 1분 전이면 된다
  const entryAtStart = check((events) => {
    events[0].entryOpensAt = events[0].startAt;
  });
  assert.equal(entryAtStart.ok, true, `entryOpensAt == startAt이 실패했다: ${entryAtStart.problems.join('; ')}`);

  const openBeforeSaleEnd = check((events) => {
    events[0].openAt = '+5h59m';
  });
  assert.equal(openBeforeSaleEnd.ok, true, `openAt이 판매 종료 1분 전인데 실패했다: ${openBeforeSaleEnd.problems.join('; ')}`);

  // 경계: 오픈 뒤 30일이 지난 시계로도 시드는 그대로 유효하다(모든 시각이 상대라 늙지 않는다)
  const first = new Date('2026-11-21T02:00:00+09:00');
  const later = new Date(first.getTime() + 30 * 86_400_000);
  const firstEvents = resolveSeedTimes(s, first).events;
  const laterEvents = resolveSeedTimes(s, later).events;
  firstEvents.forEach((e, i) => {
    for (const field of ['openAt', 'startAt', 'endAt', 'entryOpensAt']) {
      assert.equal(
        Date.parse(laterEvents[i][field]) - Date.parse(e[field]),
        30 * 86_400_000,
        `${e.key}의 ${field}가 30일 뒤에 같은 상대값으로 펼쳐지지 않았다`,
      );
    }
  });
  const laterResult = checkSeed(DEMO_SEED_FILE, later);
  assert.equal(laterResult.ok, true, `오픈 기준 30일 뒤 시드 검사가 실패했다: ${laterResult.problems.join('; ')}`);
});

test('RV-01 상대 시작 시각: 두 번째 적용은 시작 시각 차례로 기존 회차를 찾는다', () => {
  const s = seed();
  const e1 = (now) => resolveSeedTimes(s, now).events.filter((e) => e.productionKey === 'e1');
  const first = e1(new Date('2026-11-21T02:00:00+09:00'));
  const rows = first.map((e, i) => ({ id: `row-${i}`, epoch: Math.floor(Date.parse(e.startAt) / 1000) }));
  // 5분 뒤 다시 펼치면 시작 시각 값이 달라진다(epoch로 찾으면 못 찾는다). 차례로 이으면 같은 행을 찾는다
  const later = e1(new Date('2026-11-21T02:05:00+09:00'));
  assert.notEqual(Date.parse(later[0].startAt), Date.parse(first[0].startAt), '상대 시작 시각이 두 적용에서 같다');
  assert.deepEqual(matchSeedEvents(later, rows), [['e1-1025', 'row-0'], ['e1-1026', 'row-1']]);
  // 개수가 모자라면 있는 것만 잇는다(부분 상태에서도 터지지 않는다)
  assert.deepEqual(matchSeedEvents(later, rows.slice(0, 1)), [['e1-1025', 'row-0']]);
});

test('DS-05 모든 참조가 있고 비밀은 값이 아니라 환경 값 이름이다', () => {
  const s = seed();
  const accounts = new Set(s.accounts.map((a) => a.key));
  const events = new Set(s.events.map((e) => e.key));
  const productions = new Set(s.productions.map((p) => p.key));
  const promoters = new Set((s.promoters ?? []).map((p) => p.key));
  for (const a of s.accounts.filter((x) => x.kind === 'admin')) {
    assert.match(a.passwordEnv ?? '', /^DEMO_[A-Z0-9_]+$/, `${a.key}의 passwordEnv`);
    assert.match(a.totpEnv ?? '', /^DEMO_[A-Z0-9_]+$/, `${a.key}의 totpEnv`);
  }
  for (const p of s.adminPasskeys ?? []) {
    assert.ok(accounts.has(p.accountKey), `패스키의 accountKey ${p.accountKey}가 없다`);
    assert.match(p.credentialEnv ?? '', /^DEMO_[A-Z0-9_]+$/, `패스키 ${p.accountKey}의 credentialEnv`);
    assert.match(p.privateKeyEnv ?? '', /^DEMO_[A-Z0-9_]+$/, `패스키 ${p.accountKey}의 privateKeyEnv`);
  }
  for (const p of s.productions) assert.ok(promoters.has(p.promoterKey), `공연 ${p.key}의 promoterKey`);
  for (const e of s.events) assert.ok(productions.has(e.productionKey), `회차 ${e.key}의 productionKey`);
  for (const m of s.seatMaps) assert.ok(events.has(m.eventKey), `좌석맵 ${m.key}의 eventKey`);
  for (const st of s.staff) {
    assert.ok(events.has(st.eventKey), `스태프 ${st.key}의 eventKey`);
    assert.ok(accounts.has(st.accountKey), `스태프 ${st.key}의 accountKey`);
    for (const d of st.devices ?? []) assert.ok(d.name && d.booth, `기기 ${d.key}의 이름·부스`);
  }
  // 환경 값 이름은 계정·패스키 사이에서 겹치지 않는다
  const envNames = [
    ...s.accounts.filter((a) => a.kind === 'admin').flatMap((a) => [a.passwordEnv, a.totpEnv]),
    ...(s.adminPasskeys ?? []).flatMap((p) => [p.credentialEnv, p.privateKeyEnv]),
  ];
  assert.equal(new Set(envNames).size, envNames.length, '환경 값 이름이 겹친다');
});

test('DS-05 시드 검사는 빠진 참조·비밀 값 칸·실제 이메일을 잡는다', () => {
  const s = seed();
  const dir = mkdtempSync(join(tmpdir(), 'peaket-bat087-badseed-'));
  const write = (name, value) => {
    const file = join(dir, name);
    writeFileSync(file, stringifyYaml(value));
    return file;
  };
  const missingStaff = structuredClone(s);
  missingStaff.staff[0].accountKey = 'nobody';
  assert.throws(() => checkSeed(write('missing-staff.yaml', missingStaff)), /accountKey\(nobody\)가 없다/);

  const missingEvent = structuredClone(s);
  missingEvent.events[0].productionKey = 'nope';
  assert.throws(() => checkSeed(write('missing-event.yaml', missingEvent)), /productionKey\(nope\)가 없다/);

  const secretField = structuredClone(s);
  secretField.accounts[0].password = 'hunter2';
  const secretResult = checkSeed(write('secret-field.yaml', secretField));
  assert.equal(secretResult.ok, false, '시드에 password 값이 있는데 통과했다');
  assert.ok(secretResult.problems.some((p) => p.includes('password:')), `비밀 값 문제가 없다: ${secretResult.problems.join('; ')}`);

  const realEmail = structuredClone(s);
  realEmail.accounts[0].email = 'jimin@gmail.com';
  const emailResult = checkSeed(write('real-email.yaml', realEmail));
  assert.equal(emailResult.ok, false, '실제 이메일 같은 값이 통과했다');
  assert.ok(emailResult.problems.some((p) => p.includes('email')), `이메일 문제가 없다: ${emailResult.problems.join('; ')}`);

  const realPhone = structuredClone(s);
  realPhone.accounts[0].phone = '010-1234-5678';
  const phoneResult = checkSeed(write('real-phone.yaml', realPhone));
  assert.equal(phoneResult.ok, false, '전화번호 값이 통과했다');
  assert.ok(phoneResult.problems.some((p) => p.includes('전화번호')), `전화번호 문제가 없다: ${phoneResult.problems.join('; ')}`);
});

test('DS-05/06 관리 계정·패스키·promoter 부트스트랩은 local에서 두 번 적용해도 개수가 같다(가짜 pg)', () => {
  const dir = fakePgDir();
  bootstrapFile(dir);
  const state = join(dir, 'state.json');
  const env = bootstrapEnv(dir, state);
  const hook = ['--import', pathToFileURL(join(dir, 'hook.mjs')).href];

  const first = spawnSync(process.execPath, [...hook, IDENTITY_SEED, '--apply'], { cwd: REPO, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...env } });
  assert.equal(first.status, 0, `identity 첫 적용 실패: ${first.stderr}`);
  const firstOut = JSON.parse(first.stdout.trim());
  assert.deepEqual(firstOut.created, { accounts: 1, passkeys: 1 }, `첫 적용 created ${first.stdout}`);
  assert.deepEqual(firstOut.total, { accounts: 1 });
  const afterFirst = stateOf(state);
  assert.equal(Object.keys(afterFirst.accounts).length, 1);
  assert.equal(Object.keys(afterFirst.passkeys).length, 1);

  const second = spawnSync(process.execPath, [...hook, IDENTITY_SEED, '--apply'], { cwd: REPO, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...env } });
  assert.equal(second.status, 0, `identity 두 번째 적용 실패: ${second.stderr}`);
  const secondOut = JSON.parse(second.stdout.trim());
  assert.deepEqual(secondOut.created, { accounts: 0, passkeys: 0 }, `두 번째 적용이 중복 생성했다: ${second.stdout}`);
  assert.deepEqual(secondOut.total, firstOut.total, '두 번째 total이 다르다');
  const afterSecond = stateOf(state);
  assert.equal(Object.keys(afterSecond.accounts).length, 1, '두 번째 적용 뒤 계정 수가 늘었다');
  assert.equal(Object.keys(afterSecond.passkeys).length, 1, '두 번째 적용 뒤 패스키 수가 늘었다');

  const coreFirst = spawnSync(process.execPath, [...hook, CORE_SEED, '--apply'], { cwd: REPO, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...env } });
  assert.equal(coreFirst.status, 0, `core 첫 적용 실패: ${coreFirst.stderr}`);
  assert.deepEqual(JSON.parse(coreFirst.stdout.trim()).created, { promoters: 1 }, `core 첫 적용 ${coreFirst.stdout}`);
  const coreSecond = spawnSync(process.execPath, [...hook, CORE_SEED, '--apply'], { cwd: REPO, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...env } });
  assert.equal(coreSecond.status, 0, `core 두 번째 적용 실패: ${coreSecond.stderr}`);
  assert.deepEqual(JSON.parse(coreSecond.stdout.trim()).created, { promoters: 0 }, `core가 promoter를 중복 생성했다: ${coreSecond.stdout}`);
  assert.equal(Object.keys(stateOf(state).promoters).length, 1, 'promoter 수가 늘었다');
});

test('DS-06 부트스트랩은 local·ci·demo 밖(staging·prod)에서 exit 2이고 아무것도 쓰지 않는다', () => {
  const dir = fakePgDir();
  bootstrapFile(dir);
  const state = join(dir, 'state.json');
  const base = bootstrapEnv(dir, state);
  const hook = ['--import', pathToFileURL(join(dir, 'hook.mjs')).href];
  for (const envName of ['staging', 'prod']) {
    for (const script of [IDENTITY_SEED, CORE_SEED]) {
      const r = spawnSync(process.execPath, [...hook, script, '--apply'], { cwd: REPO, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...base, PEAKET_ENV: envName } });
      assert.equal(r.status, 2, `${script.split(/[\\/]/).slice(-3, -1).join('/')}이 PEAKET_ENV=${envName}에서 exit ${r.status}다: ${r.stdout}${r.stderr}`);
      assert.equal(existsSync(state), false, `PEAKET_ENV=${envName}에서 DB에 썼다`);
      assert.match(r.stderr, /PEAKET_ENV/, '까닭에 PEAKET_ENV가 없다');
    }
  }
  // local·ci·demo는 허용된다(가드가 너무 좁지 않다)
  for (const envName of ['local', 'ci', 'demo']) {
    const r = spawnSync(process.execPath, [...hook, IDENTITY_SEED, '--check'], { cwd: REPO, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...base, PEAKET_ENV: envName } });
    assert.equal(r.status, 0, `PEAKET_ENV=${envName} --check가 실패했다: ${r.stderr}`);
    assert.match(r.stdout, /"ok":true/, `${envName} --check 출력`);
  }
});

test('DS-06 부트스트랩은 감사 기록이 없다는 한계를 코드·시드에 적는다', () => {
  const identity = readFileSync(IDENTITY_SEED, 'utf8');
  const core = readFileSync(CORE_SEED, 'utf8');
  for (const [name, text] of [['identity', identity], ['core', core]]) {
    assert.match(text, /감사 기록[^\n]*없|감사[^\n]*남지 않는다/, `${name} 부트스트랩에 감사 기록 없음 표기가 없다`);
    assert.match(text, /local[^\n]*ci[^\n]*demo|ALLOWED/, `${name} 부트스트랩에 허용 환경 표기가 없다`);
    assert.match(text, /멱등|두 번/, `${name} 부트스트랩에 멱등 표기가 없다`);
  }
  const seedText = readFileSync(DEMO_SEED_FILE, 'utf8');
  assert.match(seedText, /감사 기록 없음/, '시드 파일에 부트스트랩 예외·감사 없음 표기가 없다');
});

test('DS-12 시드 파일에 개인 키·Bearer 토큰·실제 개인정보가 없다', () => {
  const text = readFileSync(DEMO_SEED_FILE, 'utf8');
  assert.doesNotMatch(text, /BEGIN (?:RSA |EC )?PRIVATE KEY/, '시드에 개인 키가 있다');
  assert.doesNotMatch(text, /Bearer\s+[A-Za-z0-9._-]{20,}/, '시드에 Bearer 토큰이 있다');
  assert.doesNotMatch(text, /(?:^|\s)password:\s*\S/im, '시드에 password 값이 있다');
  assert.doesNotMatch(text, /(?:^|\s)totp:\s*\S/im, '시드에 totp 값이 있다');
  assert.doesNotMatch(text, /(?:^|\s)privateKey:\s*\S/im, '시드에 privateKey 값이 있다');
  assert.doesNotMatch(text, /\b\d{6}-\d{7}\b/, '시드에 주민등록번호 같은 값이 있다');
  assert.doesNotMatch(text, /\b01[016789]-\d{3,4}-\d{4}\b/, '시드에 실제 휴대전화 번호 같은 값이 있다');
  const s = seed();
  for (const a of s.accounts) assert.match(a.email, /@(?:example\.test|example\.com|peaket\.test)$/, `${a.key}의 이메일이 가상 도메인이 아니다(${a.email})`);
  for (const p of s.promoters ?? []) assert.match(p.email ?? '', /@example\.test$/, `promoter ${p.key}의 이메일`);
  for (const p of s.promoters ?? []) if (p.phone) assert.match(p.phone, /^0\d-\d{4}-\d{4}$/, `promoter ${p.key}의 전화번호가 자리표시자 모양이 아니다`);
});

test('DS-12 demo-seed --check 출력·감사 표기에 비밀이 없다', () => {
  const r = run(join(REPO, 'tools', 'local', 'demo-seed.mjs'), ['--check', '--json']);
  assert.equal(r.status, 0, `demo-seed --check 실패: ${r.stderr}`);
  assert.doesNotMatch(r.stdout + r.stderr, /password|totp|Bearer|PRIVATE KEY/i, '--check 출력에 비밀 낱말·값이 있다');
  assert.match(r.stdout, /"seats": 2400/, '--check 출력에 좌석 수가 없다');
  // 저장소의 새 시드·객체·도구 파일에 비밀 파일을 만들지 않는다
  const newFiles = [
    DEMO_SEED_FILE,
    join(REPO, 'tools/local/demo-auth.mjs'),
    join(REPO, 'tools/local/demo-seed.mjs'),
    join(REPO, 'tools/local/demo-objects.mjs'),
    join(REPO, 'services/identity-svc/scripts/seed-demo.mjs'),
    join(REPO, 'services/core-svc/scripts/seed-demo.mjs'),
  ];
  for (const file of newFiles) {
    const mode = statSync(file).mode & 0o777;
    if (process.platform !== 'win32') assert.equal(mode & 0o077, 0, `${file}의 권한이 너무 넓다(${mode.toString(8)})`);
  }
  // 저장소에 새 비밀 파일(.pem·.key)이 없다
  const secrets = readdirSync(join(REPO, 'deploy', 'envs', 'demo', 'seed')).filter((f) => /\.(?:pem|key|p12|pfx)$/i.test(f));
  assert.deepEqual(secrets, [], `시드 폴더에 비밀 파일이 있다: ${secrets.join(', ')}`);
});
