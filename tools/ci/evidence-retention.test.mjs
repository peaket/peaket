// 진단 증거 보존 규칙 정적 검사(tools/ci/evidence-retention.mjs)의 시험(기능 F-01-1, OPS-030, 시험 D-T52 ①).
// 정본: docs/observability.md §9 '진단 증거' 행(보존 일수·연장 일수·이전 판과 남은 조각 지우기·보존 태그), docs/devops.md D-T52.
// 수명 주기 원천 infra/modules/evidence-bucket/lifecycle.json은 S3 PutBucketLifecycleConfiguration의 JSON 꼴({"Rules":[…]})이다.
// 단언 값은 §9 행에서 읽는다(검사 도구의 상수를 가져오지 않는다). 임시 저장소에는 그 두 파일만 복사해 한 군데씩 바꾼다.
// 실행(저장소 뿌리): node --test tools/ci/evidence-retention.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO, 'tools', 'ci', 'evidence-retention.mjs');
const DOC = join('docs', 'observability.md');
const LIFECYCLE = join('infra', 'modules', 'evidence-bucket', 'lifecycle.json');
const ROW_HEAD = '| 진단 증거(진단 보고서';

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
const blocked = (out) => out.split(/\r?\n/).filter((l) => l.startsWith('막음: '));

/** §9 '진단 증거' 행에서 정본 값을 읽는다(시험 쪽 독립 읽기) */
function canon(docText = readFileSync(join(REPO, DOC), 'utf8')) {
  const row = docText.split(/\r?\n/).find((l) => l.startsWith(ROW_HEAD));
  assert.ok(row, 'observability.md §9에 진단 증거 행이 있다');
  const num = (re, what) => {
    const m = re.exec(row);
    assert.ok(m, `§9 행에서 ${what}을(를) 읽는다`);
    return Number(m[1]);
  };
  const tags = [...row.matchAll(/`([a-z][a-z0-9-]*)=([a-z]+)`/g)].map((m) => ({ key: m[1], value: m[2] }));
  assert.equal(tags.length, 2, '§9 행의 보존 태그 글귀는 standard·hold 둘');
  return {
    standardDays: num(/(\d+)일 \[가정\] 뒤 수명 주기 규칙으로 삭제/, '보존 일수'),
    holdDays: num(/(\d+)일 \[가정\]까지 연장/, '연장 일수'),
    noncurrentDays: num(/이전 판이 된 객체는 (\d+)일/, '이전 판 지우기 일수'),
    abortMultipartDays: num(/여러 조각 올리기는 (\d+)일/, '남은 조각 지우기 일수'),
    tagKey: tags[0].key,
    standardValue: tags[0].value,
    holdValue: tags[1].value,
  };
}

/** 규칙의 태그 거르개(Filter.Tag 또는 Filter.And.Tags) */
function tagsOf(rule) {
  const f = rule.Filter ?? {};
  if (f.Tag) return [f.Tag];
  if (f.And?.Tags) return f.And.Tags;
  return [];
}
const ruleWithTag = (cfg, key, value) => {
  const r = cfg.Rules.find((x) => tagsOf(x).some((t) => t.Key === key && t.Value === value));
  assert.ok(r, `원천에 ${key}=${value} 태그 규칙이 있다`);
  return r;
};

/** 실제 저장소의 두 파일만 복사한 임시 저장소. change(doc, cfg)가 바꾼 값을 쓴다 */
function tempRepo(change) {
  const root = mkdtempSync(join(tmpdir(), 'evidence-retention-'));
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'infra', 'modules', 'evidence-bucket'), { recursive: true });
  const state = { doc: readFileSync(join(REPO, DOC), 'utf8'), lifecycle: readFileSync(join(REPO, LIFECYCLE), 'utf8') };
  if (change) change(state);
  writeFileSync(join(root, DOC), state.doc);
  if (state.lifecycle !== null) writeFileSync(join(root, LIFECYCLE), state.lifecycle);
  return root;
}
/** 원천 JSON을 고쳐 쓰는 바꾸기 */
const editCfg = (fn) => (state) => {
  const cfg = JSON.parse(state.lifecycle);
  fn(cfg);
  state.lifecycle = JSON.stringify(cfg, null, 2);
};
/** §9 행만 바꾼다(다른 줄의 같은 글귀는 그대로) */
const editRow = (fn) => (state) => {
  state.doc = state.doc
    .split('\n')
    .map((l) => (l.startsWith(ROW_HEAD) ? fn(l) : l))
    .join('\n');
};

function check(root) {
  try {
    return run(['--check', '--root', root]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('D-T52 ① [ASVS v5.0.0-14.1.2] [ASVS v5.0.0-14.2.7] 수명 주기 원천이 §9 보존 표와 다르면 막는다', async (t) => {
  const c = canon();
  // 정본 값 자체(시험이 행을 잘못 읽으면 아래 바꾸기가 엉뚱한 값을 고친다)
  assert.deepEqual(c, { standardDays: 14, holdDays: 30, noncurrentDays: 1, abortMultipartDays: 1, tagKey: 'peaket-retention', standardValue: 'standard', holdValue: 'hold' });

  await t.test('실제 저장소는 0으로 끝난다', () => {
    const r = run(['--check']);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(blocked(r.out), []);
    const r2 = run(['--check', '--root', REPO]);
    assert.equal(r2.code, 0, r2.out);
  });

  await t.test('원천은 정한 규칙 셋을 모두 켜 두고 다른 저장 등급으로 옮기지 않는다(실제 원천 모양)', () => {
    const cfg = JSON.parse(readFileSync(join(REPO, LIFECYCLE), 'utf8'));
    assert.ok(Array.isArray(cfg.Rules) && cfg.Rules.length >= 3, 'Rules 배열에 규칙이 셋 이상');
    for (const r of cfg.Rules) {
      assert.equal(r.Status, 'Enabled', `규칙 ${r.ID}이 켜져 있다`);
      assert.equal(r.Transitions, undefined, `규칙 ${r.ID}에 Transitions가 없다`);
      assert.equal(r.NoncurrentVersionTransitions, undefined, `규칙 ${r.ID}에 NoncurrentVersionTransitions가 없다`);
    }
    assert.equal(ruleWithTag(cfg, c.tagKey, c.standardValue).Expiration?.Days, c.standardDays);
    assert.equal(ruleWithTag(cfg, c.tagKey, c.holdValue).Expiration?.Days, c.holdDays);
    const cleanup = cfg.Rules.filter((r) => (r.Filter ?? {}).Prefix === '');
    assert.ok(cleanup.length >= 1, '빈 앞머리({"Prefix": ""}) 정리 규칙이 있다');
    assert.ok(cleanup.some((r) => r.NoncurrentVersionExpiration?.NoncurrentDays === c.noncurrentDays), '이전 판 지우기');
    assert.ok(cleanup.some((r) => r.AbortIncompleteMultipartUpload?.DaysAfterInitiation === c.abortMultipartDays), '남은 조각 지우기');
    assert.ok(cleanup.some((r) => r.Expiration?.ExpiredObjectDeleteMarker === true), '남은 삭제 표시 치우기');
  });

  const cases = [
    ['standard 태그 규칙의 지우는 날 +1', editCfg((cfg) => void (ruleWithTag(cfg, c.tagKey, c.standardValue).Expiration.Days = c.standardDays + 1))],
    ['hold 태그 규칙의 지우는 날 +1', editCfg((cfg) => void (ruleWithTag(cfg, c.tagKey, c.holdValue).Expiration.Days = c.holdDays + 1))],
    ['이전 판 지우기 날 +1', editCfg((cfg) => void (cfg.Rules.find((r) => r.NoncurrentVersionExpiration).NoncurrentVersionExpiration.NoncurrentDays = c.noncurrentDays + 1))],
    ['남은 조각 지우기 날 +1', editCfg((cfg) => void (cfg.Rules.find((r) => r.AbortIncompleteMultipartUpload).AbortIncompleteMultipartUpload.DaysAfterInitiation = c.abortMultipartDays + 1))],
    ['정리 규칙(이전 판·남은 조각) 빠짐', editCfg((cfg) => void (cfg.Rules = cfg.Rules.filter((r) => !r.NoncurrentVersionExpiration && !r.AbortIncompleteMultipartUpload)))],
    ['이전 판 지우기만 빠짐', editCfg((cfg) => void delete cfg.Rules.find((r) => r.NoncurrentVersionExpiration).NoncurrentVersionExpiration)],
    ['남은 삭제 표시 치우기 빠짐', editCfg((cfg) => void delete cfg.Rules.find((r) => r.Expiration?.ExpiredObjectDeleteMarker).Expiration.ExpiredObjectDeleteMarker)],
    ['standard 태그 규칙이 꺼짐(Disabled)', editCfg((cfg) => void (ruleWithTag(cfg, c.tagKey, c.standardValue).Status = 'Disabled'))],
    ['hold 태그 규칙 빠짐', editCfg((cfg) => void (cfg.Rules = cfg.Rules.filter((r) => !tagsOf(r).some((x) => x.Value === c.holdValue))))],
    ['다른 저장 등급으로 옮기는 규칙(Transitions) 더함', editCfg((cfg) => void (ruleWithTag(cfg, c.tagKey, c.standardValue).Transitions = [{ Days: 7, StorageClass: 'GLACIER' }]))],
    ['이전 판을 옮기는 규칙(NoncurrentVersionTransitions) 더함', editCfg((cfg) => void (cfg.Rules.find((r) => r.NoncurrentVersionExpiration).NoncurrentVersionTransitions = [{ NoncurrentDays: 1, StorageClass: 'GLACIER' }]))],
    [
      '연장 일수보다 오래 두는 규칙 더함',
      editCfg((cfg) => void cfg.Rules.push({ ID: 'extra-long', Status: 'Enabled', Filter: { Prefix: 'example-svc/' }, Expiration: { Days: c.holdDays + 1 } })),
    ],
    ['standard 태그 값 standard → std', editCfg((cfg) => void (tagsOf(ruleWithTag(cfg, c.tagKey, c.standardValue))[0].Value = 'std'))],
    ['태그 이름 peaket-retention → peaket-retain', editCfg((cfg) => void (tagsOf(ruleWithTag(cfg, c.tagKey, c.standardValue))[0].Key = 'peaket-retain'))],
    // 문서 쪽이 바뀌어도 잡는다(원천은 그대로, §9 행의 보존·연장 일수만 바꿈)
    ['§9 행의 보존 일수 14 → 15', editRow((l) => l.replace(`${c.standardDays}일 [가정] 뒤 수명 주기 규칙으로 삭제`, `${c.standardDays + 1}일 [가정] 뒤 수명 주기 규칙으로 삭제`))],
    ['§9 행의 연장 일수 30 → 31', editRow((l) => l.replace(`${c.holdDays}일 [가정]까지 연장`, `${c.holdDays + 1}일 [가정]까지 연장`))],
  ];
  for (const [name, change] of cases) {
    await t.test(`${name} → 1이고 어긋남을 찍는다`, () => {
      const r = check(tempRepo(change));
      assert.equal(r.code, 1, `${name}: ${r.out}`);
      assert.ok(blocked(r.out).length >= 1, `'막음: <파일>: <까닭>' 줄이 있다: ${r.out}`);
      for (const l of blocked(r.out)) assert.match(l, /^막음: \S+: \S/);
    });
  }

  await t.test('바꾸지 않은 임시 저장소는 0이다(위 1이 복사 탓이 아니다)', () => {
    const r = check(tempRepo());
    assert.equal(r.code, 0, r.out);
  });

  await t.test('어긋남이 둘이면 둘 다 찍는다', () => {
    const r = check(
      tempRepo(
        editCfg((cfg) => {
          ruleWithTag(cfg, c.tagKey, c.standardValue).Expiration.Days = c.standardDays + 1;
          ruleWithTag(cfg, c.tagKey, c.holdValue).Status = 'Disabled';
        }),
      ),
    );
    assert.equal(r.code, 1, r.out);
    assert.ok(blocked(r.out).length >= 2, `막음 줄이 둘 이상: ${r.out}`);
  });

  const unreadable = [
    ['§9 진단 증거 행을 지움', (s) => void (s.doc = s.doc.split('\n').filter((l) => !l.startsWith(ROW_HEAD)).join('\n'))],
    ['원천 JSON이 깨짐', (s) => void (s.lifecycle = s.lifecycle.slice(0, Math.floor(s.lifecycle.length / 2)))],
    ['원천 파일이 없음', (s) => void (s.lifecycle = null)],
  ];
  for (const [name, change] of unreadable) {
    await t.test(`${name} → 2`, () => {
      const r = check(tempRepo(change));
      assert.equal(r.code, 2, `${name}: ${r.out}`);
    });
  }

  await t.test('모르는 인자 → 2', () => {
    assert.equal(run(['--check', '--bogus']).code, 2);
    assert.equal(run([]).code, 2);
  });

  await t.test('내보낸 함수: readRetentionPolicy는 §9 행에서 읽고 checkEvidenceRetention은 어긋남 목록을 낸다', async () => {
    const mod = await import(pathToFileURL(SCRIPT).href);
    assert.deepEqual(mod.readRetentionPolicy(REPO), c);
    assert.deepEqual(mod.checkEvidenceRetention(REPO), []);
    // 문서 값을 정본과 다른 숫자로 바꾼 임시 저장소: 읽은 값이 그 숫자를 따른다(상수가 아니다)
    const root = tempRepo(
      editRow((l) =>
        l
          .replace(`${c.standardDays}일 [가정] 뒤 수명 주기 규칙으로 삭제`, '9일 [가정] 뒤 수명 주기 규칙으로 삭제')
          .replace(`${c.holdDays}일 [가정]까지 연장`, '23일 [가정]까지 연장')
          .replace(`이전 판이 된 객체는 ${c.noncurrentDays}일`, '이전 판이 된 객체는 2일')
          .replace(`여러 조각 올리기는 ${c.abortMultipartDays}일`, '여러 조각 올리기는 3일'),
      ),
    );
    try {
      assert.deepEqual(mod.readRetentionPolicy(root), { ...c, standardDays: 9, holdDays: 23, noncurrentDays: 2, abortMultipartDays: 3 });
      const problems = mod.checkEvidenceRetention(root);
      assert.ok(Array.isArray(problems) && problems.length >= 4, `네 값이 모두 어긋난다: ${JSON.stringify(problems)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    const gone = tempRepo((s) => void (s.doc = s.doc.split('\n').filter((l) => !l.startsWith(ROW_HEAD)).join('\n')));
    try {
      assert.throws(() => mod.readRetentionPolicy(gone));
    } finally {
      rmSync(gone, { recursive: true, force: true });
    }
  });
});
