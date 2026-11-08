// 엣지 저장소 서명 키 맞추기(tools/edge/sync-kvs-keys.mjs, ADR-0223 결정 10).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { awsDriver, main, reportLines, syncEntries } from './sync-kvs-keys.mjs';

const KEY_A = 'a'.repeat(43);
const KEY_B = 'b'.repeat(43);
const KEY_C = 'c'.repeat(43);

const fake = (start = {}) => {
  const store = new Map(Object.entries(start));
  let version = 1;
  const puts = [];
  return {
    store,
    puts,
    async get(k) {
      return store.has(k) ? store.get(k) : null;
    },
    async put(k, v, etag) {
      assert.equal(etag, `v${version}`, '지금 판 표시로 쓴다');
      store.set(k, v);
      puts.push(k);
      version++;
    },
    async etag() {
      return `v${version}`;
    },
  };
};

test('[ASVS v5.0.0-13.3.2] 없는키는넣고_다른키는다시넣으며_보고에는이름만싣는다', async () => {
  const d = fake({ 'arr:cur': 'k1', 'arr:key:k1': KEY_A });
  const report = await syncEntries(d, { 'arr:cur': 'k1', 'arr:key:k1': KEY_B, 'arr:key:k2': KEY_C });
  assert.deepEqual(report, { missing: ['arr:key:k2'], changed: ['arr:key:k1'], same: ['arr:cur'], rotated: [] });
  assert.equal(d.store.get('arr:key:k1'), KEY_B);
  const text = reportLines(report).join('\n');
  assert.match(text, /경보.*arr:key:k1/);
  for (const secret of [KEY_A, KEY_B, KEY_C]) assert.equal(text.includes(secret), false);
});

test('[ASVS v5.0.0-13.3.2] 같은값이면_쓰지않고_경보하지않는다', async () => {
  const d = fake({ 'arr:cur': 'k1', 'arr:key:k1': KEY_A });
  const report = await syncEntries(d, { 'arr:cur': 'k1', 'arr:key:k1': KEY_A });
  assert.deepEqual(report.changed, []);
  assert.deepEqual(d.puts, []);
  assert.deepEqual(reportLines(report), []);
});

test('[ASVS v5.0.0-13.3.2] 규칙에맞지않는키이름·kid꼴·짧은키·없는kid를가리키면_쓰지않고실패하고_값을문구에싣지않는다', async () => {
  for (const k of ['sale:evt-1', 'mode:entry', 'arr:key:bad/kid', 'other']) {
    const d = fake();
    await assert.rejects(syncEntries(d, { [k]: KEY_A }), /규칙/);
    assert.equal(d.puts.length, 0);
  }
  const cases = [
    { 'arr:cur': '', 'arr:key:k1': KEY_A },
    { 'arr:cur': 'bad kid!', 'arr:key:k1': KEY_A },
    { 'arr:cur': 'k1', 'arr:key:k1': 'short-secret-value' },
    { 'arr:cur': 'k2', 'arr:key:k1': KEY_A },
  ];
  for (const entries of cases) {
    const d = fake();
    await assert.rejects(syncEntries(d, entries), (e) => {
      assert.equal(e.message.includes('short-secret-value') || e.message.includes(KEY_A), false);
      return true;
    });
    assert.equal(d.puts.length, 0);
  }
});

test('[ASVS v5.0.0-13.3.2] 키를먼저넣고_arr:cur를마지막에넣는다(엣지가없는키를가리키지않게)', async () => {
  const d = fake({ 'arr:cur': 'k1', 'arr:key:k1': KEY_A });
  await syncEntries(d, { 'arr:cur': 'k2', 'arr:key:k1': KEY_A, 'arr:key:k2': KEY_B }, { rotating: true });
  assert.deepEqual(d.puts, ['arr:key:k2', 'arr:cur']);
});

test('[ASVS v5.0.0-13.3.2] 교체뜻을주면_arr:cur가달라도경보가아니고_주지않으면경보다', async () => {
  const entries = { 'arr:cur': 'k2', 'arr:key:k1': KEY_A, 'arr:key:k2': KEY_B };
  const rotated = await syncEntries(fake({ 'arr:cur': 'k1', 'arr:key:k1': KEY_A, 'arr:key:k2': KEY_B }), entries, { rotating: true });
  assert.deepEqual(rotated.changed, []);
  assert.deepEqual(rotated.rotated, ['arr:cur']);
  const silent = await syncEntries(fake({ 'arr:cur': 'k1', 'arr:key:k1': KEY_A, 'arr:key:k2': KEY_B }), entries);
  assert.deepEqual(silent.changed, ['arr:cur']);
  // 교체 뜻이 있어도 서명 키 값이 다르면 경보다
  const tampered = await syncEntries(fake({ 'arr:cur': 'k1', 'arr:key:k1': KEY_C, 'arr:key:k2': KEY_B }), entries, { rotating: true });
  assert.deepEqual(tampered.changed, ['arr:key:k1']);
});

const entriesFile = (body) => {
  const dir = mkdtempSync(join(tmpdir(), 'kvs-test-'));
  const f = join(dir, 'entries.json');
  writeFileSync(f, body);
  return f;
};
const captured = () => {
  const lines = [];
  return { lines, error: (s) => lines.push(String(s)) };
};
const ARN = 'arn:aws:cloudfront::1:key-value-store/x';
/** aws 호출 대역: execFile처럼 실패하면 명령줄이 든 message와 stderr를 던진다 */
const exec = (o = {}) => {
  const calls = [];
  const fn = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const op = args[1];
    if (o.fail?.(op)) {
      const e = new Error(`Command failed: ${cmd} ${args.join(' ')}`);
      e.stderr = o.stderr ?? 'An error occurred (ConflictException) when calling the PutKey operation: precondition';
      throw e;
    }
    if (op === 'describe-key-value-store') return { stdout: JSON.stringify({ ETag: 'e1' }) };
    if (op === 'get-key') return { stdout: o.getKeyStdout ?? JSON.stringify({ Value: null }) };
    if (op === 'put-key') {
      const m = /^file:\/\/(.+)$/.exec(args[args.indexOf('--cli-input-json') + 1] ?? '');
      assert.ok(m, 'put-key는 --cli-input-json file://로 값을 넘긴다');
      o.seen?.(m[1], JSON.parse(readFileSync(m[1], 'utf8')));
      return { stdout: '{}' };
    }
    return { stdout: '{}' };
  };
  return { fn, calls };
};

test('[ASVS v5.0.0-13.3.2] 값은명령줄에실리지않고_권한좁은임시파일로넘기며_끝나면지운다', async () => {
  let path;
  let mode;
  let body;
  const e = exec({ seen: (p, b) => ((path = p), (mode = statSync(p).mode & 0o777), (body = b)) });
  const d = awsDriver(ARN, e.fn);
  await d.put('arr:key:k1', KEY_A, 'e1');
  for (const c of e.calls) assert.equal(c.args.includes(KEY_A), false, '인자에 값이 없다');
  assert.deepEqual(body, { KvsARN: ARN, Key: 'arr:key:k1', Value: KEY_A, IfMatch: 'e1' });
  if (process.platform !== 'win32') assert.equal(mode, 0o600);
  assert.equal(existsSync(path), false, '임시 파일을 지운다');
});

test('[ASVS v5.0.0-13.3.2] 저장소호출이실패해도_값을출력하지않고_AWS오류이름만찍는다', async () => {
  const log = captured();
  const code = await main(['--kvs-arn', ARN, '--entries', entriesFile(JSON.stringify({ 'arr:cur': 'k1', 'arr:key:k1': KEY_A }))], { exec: exec({ fail: (op) => op === 'put-key' }).fn, console: log });
  assert.equal(code, 2);
  const out = log.lines.join('\n');
  assert.equal(out.includes(KEY_A), false);
  assert.match(out, /ConflictException/);
});

test('[ASVS v5.0.0-13.3.2] AWS오류문구에값이섞여있어도_찍지않는다', async () => {
  const log = captured();
  const stderr = `An error occurred (ValidationException) when calling the PutKey operation: bad value ${KEY_A}`;
  await main(['--kvs-arn', ARN, '--entries', entriesFile(JSON.stringify({ 'arr:cur': 'k1', 'arr:key:k1': KEY_A }))], { exec: exec({ fail: (op) => op === 'put-key', stderr }).fn, console: log });
  const out = log.lines.join('\n');
  assert.equal(out.includes(KEY_A), false);
  assert.match(out, /ValidationException/);
});

test('[ASVS v5.0.0-13.3.2] 항목파일이깨져도_값조각을찍지않는다', async () => {
  const log = captured();
  const code = await main(['--kvs-arn', ARN, '--entries', entriesFile(`{"arr:key:k1": "${KEY_A}`)], { exec: exec().fn, console: log });
  assert.equal(code, 2);
  assert.equal(log.lines.join('\n').includes(KEY_A), false);
});

test('[ASVS v5.0.0-13.3.2] 응답이깨진JSON이어도_값조각을찍지않는다', async () => {
  const log = captured();
  await main(['--kvs-arn', ARN, '--entries', entriesFile(JSON.stringify({ 'arr:cur': 'k1', 'arr:key:k1': KEY_A }))], { exec: exec({ getKeyStdout: `{"Value":"${KEY_B}` }).fn, console: log });
  assert.equal(log.lines.join('\n').includes(KEY_B), false);
});

test('[ASVS v5.0.0-13.3.2] 교체뜻인자와종료코드: 정상교체0_몰래바뀜3', async () => {
  const body = JSON.stringify({ 'arr:cur': 'k2', 'arr:key:k1': KEY_A, 'arr:key:k2': KEY_B });
  const stored = { 'arr:cur': 'k1', 'arr:key:k1': KEY_A, 'arr:key:k2': KEY_B };
  const driverExec = () => {
    const e = exec({});
    const orig = e.fn;
    return async (cmd, args, opts) => {
      if (args[1] === 'get-key') return { stdout: JSON.stringify({ Value: stored[args[args.indexOf('--key') + 1]] ?? null }) };
      return orig(cmd, args, opts);
    };
  };
  const a = captured();
  assert.equal(await main(['--kvs-arn', ARN, '--entries', entriesFile(body), '--rotate'], { exec: driverExec(), console: a }), 0);
  assert.equal(a.lines.some((l) => l.includes('경보')), false);
  const b = captured();
  assert.equal(await main(['--kvs-arn', ARN, '--entries', entriesFile(body)], { exec: driverExec(), console: b }), 3);
  assert.equal(b.lines.some((l) => l.includes('경보')), true);
});
