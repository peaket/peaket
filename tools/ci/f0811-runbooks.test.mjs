// F-08-11 문서 계약 시험. Docker·kind·k6·브라우저 없이 문서만 읽는다.
// 정본 값은 시험 안에 적고, 구현 상수를 가져오지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNBOOK_DIR = path.join(ROOT, 'docs', 'runbooks');
const RUNBOOK_IDS = Array.from({ length: 41 }, (_, i) => `RB-${String(i + 1).padStart(2, '0')}`);

// 7.2 통제 어휘. 정본의 서비스 목록과 새 색인의 영역을 함께 둔다.
const AREAS = [
  'queue-svc',
  'admission-ctrl',
  'purchase-svc',
  'payment-svc',
  'ticket-svc',
  'realtime-gw',
  'identity-svc',
  'trust-svc',
  'ops-svc',
  'core-svc',
  '게이트웨이',
  '관측',
  '배포·플랫폼',
  '보안·법정',
  '공통·운영',
];
const SYMPTOMS = ['가용성', '지연', '오류·정합성', '포화·용량', '보안·법정', '변경·배포', '데이터 손상·복구', '관측 공백'];
const DETECTIONS = ['경보', '사람', '외부', '경보·사람·외부'];
const ROLES = [
  '서비스 담당',
  '온콜',
  '인시던트 지휘관(IC)',
  '운영 실행자(OL)',
  '기록·대외 공지 담당(CL)',
  '보안 담당',
  '플랫폼 담당',
  'DBA',
  '릴리스 담당',
];
// docs/planning/03-policies-glossary.md §4 '원인 유형'의 9가지.
const CAUSES = ['변경', '외부 의존', '내부 저장소·메시징', '용량·포화', '코드 결함', '데이터', '보안', '운영 조작', '기반'];
const META_KEYS = ['서비스·영역', '증상 분류', '증상', '탐지 경로', '심각도', '발동 신호', '담당', '목표 시간'];
const SECTION_TITLES = ['즉시 조치', '에스컬레이션', '복구 확인', '포스트모템', '관련 정본', '연습'];
const EXECUTION_CLAIMS = ['실행했다', '검증됐다', '측정했다'];
const FORBIDDEN_CLAIMS = ['30k/s', '100만', 'K1', 'K2', 'K7'];
// 7.2가 이름으로 정한 전용 런북이 없는 서비스 행의 연결 런북.
const SERVICE_CONNECTIONS = {
  'ticket-svc': ['RB-36', 'RB-33'],
  'identity-svc': ['RB-26', 'RB-21'],
  'trust-svc': ['RB-26', 'RB-33'],
  'realtime-gw': ['RB-06', 'RB-33'],
};

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function runbookFiles() {
  assert.ok(fs.existsSync(RUNBOOK_DIR), 'docs/runbooks/ 폴더가 없다');
  const all = fs.readdirSync(RUNBOOK_DIR).filter((f) => /^RB-.*\.md$/.test(f)).sort();
  const unexpected = all.filter((f) => !/^RB-(0[1-9]|[1-3]\d|4[01])\.md$/.test(f));
  assert.deepEqual(unexpected, [], `예상 밖 런북 파일이 있다(41종 밖): ${unexpected.join(', ')}`);
  return all;
}

function h1(text) {
  const m = text.match(/^# (.+)$/m);
  return m ? m[1].trim() : null;
}

function meta(text, key) {
  const m = text.match(new RegExp(`^- \\*\\*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*\\*: (.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

function section(text, title) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${title}`);
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

function numberedSteps(body) {
  return body ? body.split('\n').filter((l) => /^\d+\.\s+/.test(l.trim())).length : 0;
}

function tableAfter(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return null;
  const rows = [];
  let seenHeader = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (/^## /.test(line)) break;
    if (!line.startsWith('|')) continue;
    const cells = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
    if (!seenHeader) {
      seenHeader = true;
      continue;
    }
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue;
    rows.push(cells);
  }
  return rows;
}

function links(body) {
  return [...body.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((m) => m[1].trim());
}

function rbLinks(cell) {
  const pairs = [...cell.matchAll(/\[(RB-\d\d)\]\((RB-\d\d)\.md\)/g)].map((m) => ({ id: m[1], target: m[2] }));
  for (const pair of pairs) assert.equal(pair.id, pair.target, `색인 링크 글자와 대상이 다르다: [${pair.id}](${pair.target}.md)`);
  return pairs.map((pair) => pair.id);
}

function assertPractice(body, file) {
  assert.ok(body, `${file}: '## 연습' 절이 없다`);
  assert.match(body, /^(?:[-*]\s+)?미실행/, `${file}: '## 연습'이 '미실행'으로 시작하지 않는다`);
  for (const id of ['F-08-6', 'F-08-12', 'F-08-13']) {
    assert.ok(body.includes(id), `${file}: '## 연습'에 ${id} 경계가 없다`);
  }
}

function assertTargetTime(file, value) {
  assert.ok(value, `${file}: 목표 시간이 없다`);
  if (/^(미정|미측정)(?:\s*[—–-]\s*[^0-9]+)?$/.test(value)) return;
  const targets = links(value);
  const hasCanonical = targets.some((t) => t.startsWith('../') || t.startsWith('docs/'));
  assert.ok(hasCanonical, `${file}: 목표 시간이 미정·미측정도 아니고 같은 줄에 정본 링크도 없다`);
  if (/\d/.test(value)) {
    assert.ok(hasCanonical, `${file}: 목표 시간에 숫자가 있으면 같은 줄에 정본 링크가 있어야 한다`);
  }
}

function assertNoExecutionClaim(text, file) {
  for (const line of text.split('\n')) {
    for (const claim of EXECUTION_CLAIMS) {
      if (!line.includes(claim)) continue;
      assert.match(line, /미실행|하지 않|없다|아니다|금지|주장하지/, `${file}: '${claim}' 실행 주장이 있다: ${line.trim()}`);
    }
  }
}

function assertNoPositiveClaim(text, file) {
  for (const line of text.split('\n')) {
    for (const claim of FORBIDDEN_CLAIMS) {
      if (!line.includes(claim)) continue;
      assert.match(
        line,
        /주장하지 않는다|미주장|주장하지 않음|수치 주장 없음/,
        `${file}: '${claim}' 달성값을 긍정으로 주장하는 줄이 있다: ${line.trim()}`,
      );
    }
  }
}

function assertRunbookDir() {
  assert.ok(fs.existsSync(RUNBOOK_DIR), 'docs/runbooks/ 폴더가 없다(런북 41종 파일이 아직 없다)');
}

test('F0811-1 ① 런북 41종이 RB-01~RB-41 파일·제목과 정확히 한 번씩 맞는다', () => {
  assertRunbookDir();
  const files = runbookFiles();
  const ids = files.map((f) => f.replace(/\.md$/, ''));
  assert.equal(files.length, 41, `런북 파일이 41개가 아니라 ${files.length}개다`);
  assert.deepEqual(ids, RUNBOOK_IDS, 'RB-01~RB-41이 빠지거나 겹쳤다');
  for (const file of files) {
    const text = read(path.posix.join('docs/runbooks', file));
    const title = h1(text);
    const id = file.replace(/\.md$/, '');
    assert.ok(title, `${file}: H1 제목이 없다`);
    assert.match(title, new RegExp(`^${id}: .+`), `${file}: H1이 '# ${id}: 제목' 꼴이 아니다`);
  }
});

test('F0811-1 ② 런북마다 필수 메타·절·연습 미실행이 있고 틀이 같은 계약을 보인다', () => {
  assertRunbookDir();
  const files = runbookFiles();
  assert.equal(files.length, 41, '런북 파일이 41개가 아니다');
  for (const file of files) {
    const text = read(path.posix.join('docs/runbooks', file));
    for (const key of META_KEYS) {
      assert.ok(meta(text, key), `${file}: '- **${key}**: …' 줄이 없다`);
    }
    assert.ok(AREAS.includes(meta(text, '서비스·영역')), `${file}: 서비스·영역 '${meta(text, '서비스·영역')}'이 통제 어휘 밖이다`);
    assert.ok(SYMPTOMS.includes(meta(text, '증상 분류')), `${file}: 증상 분류 '${meta(text, '증상 분류')}'이 통제 어휘 밖이다`);
    assert.ok(DETECTIONS.includes(meta(text, '탐지 경로')), `${file}: 탐지 경로 '${meta(text, '탐지 경로')}'이 통제 어휘 밖이다`);
    assert.match(meta(text, '심각도'), /SEV[123]/, `${file}: 심각도에 SEV1·SEV2·SEV3이 없다`);
    for (const title of SECTION_TITLES) {
      assert.ok(section(text, title), `${file}: '## ${title}' 절이 없다`);
    }
    assert.ok(numberedSteps(section(text, '즉시 조치')) >= 3, `${file}: 즉시 조치 번호 목록이 3개 미만이다`);
    assertPractice(section(text, '연습'), file);
  }

  const template = read('docs/runbooks/_template.md');
  assert.ok(template.includes('RB-NN'), '_template.md에 RB-NN 자리가 없다');
  for (const key of META_KEYS) assert.ok(meta(template, key), `_template.md: '- **${key}**: …' 줄이 없다`);
  for (const title of SECTION_TITLES) assert.ok(section(template, title), `_template.md: '## ${title}' 절이 없다`);
  assertPractice(section(template, '연습'), '_template.md');
});

test('F0811-2 ① 서비스별 색인이 10개 서비스와 게이트웨이·공통 영역을 모두 덮는다', () => {
  const index = read('docs/runbooks/index.md');
  const areaOf = new Map();
  for (const id of RUNBOOK_IDS) {
    const text = read(`docs/runbooks/${id}.md`);
    areaOf.set(id, meta(text, '서비스·영역'));
  }

  const rows = tableAfter(index, '서비스·영역별 색인');
  assert.ok(rows, 'index.md에 서비스·영역별 색인 표가 없다');
  assert.equal(rows.length, AREAS.length, `서비스·영역별 색인 행이 ${AREAS.length}개가 아니다`);
  const areas = rows.map((r) => r[0]);
  for (const area of AREAS) assert.ok(areas.includes(area), `서비스·영역별 색인에 '${area}' 행이 없다`);
  const rowOf = new Map(rows.map((r) => [r[0], r[1]]));
  for (const [area, cell] of rows) {
    const ids = rbLinks(cell);
    assert.ok(ids.length > 0, `'${area}' 행에 런북 링크가 없다`);
  }
  for (const id of RUNBOOK_IDS) {
    const area = areaOf.get(id);
    assert.ok(area, `${id}: 서비스·영역 메타가 없다`);
    assert.ok(rbLinks(rowOf.get(area)).includes(id), `${id}가 자기 서비스·영역 '${area}' 행에 없다`);
  }
  for (const [area, ids] of Object.entries(SERVICE_CONNECTIONS)) {
    const cell = rowOf.get(area);
    assert.ok(cell, `서비스·영역별 색인에 '${area}' 행이 없다`);
    const linked = rbLinks(cell);
    for (const id of ids) assert.ok(linked.includes(id), `'${area}' 행이 7.2가 정한 ${id}를 가리키지 않는다`);
  }

  const list = tableAfter(index, '41종 목록');
  assert.ok(list, 'index.md에 41종 목록 표가 없다');
  assert.equal(list.length, 41, `41종 목록 행이 41개가 아니다(${list.length})`);
  const seen = new Set();
  for (const [idCell, title, area, symptom, severity] of list) {
    const idMatch = idCell.match(/^\[(RB-\d\d)\]\((RB-\d\d)\.md\)$/);
    assert.ok(idMatch, `41종 목록의 ID 칸이 [RB-NN](RB-NN.md) 링크가 아니다: ${idCell}`);
    assert.equal(idMatch[1], idMatch[2], `41종 목록의 링크 글자와 대상이 다르다: ${idCell}`);
    const id = idMatch[1];
    assert.ok(!seen.has(id), `41종 목록에 ${id}가 두 번 나온다`);
    seen.add(id);
    const text = read(`docs/runbooks/${id}.md`);
    assert.equal(title, h1(text).replace(/^RB-\d\d: /, ''), `${id}: 41종 목록 제목이 파일 제목과 다르다`);
    assert.equal(area, meta(text, '서비스·영역'), `${id}: 41종 목록 서비스·영역이 파일과 다르다`);
    assert.equal(symptom, meta(text, '증상 분류'), `${id}: 41종 목록 증상 분류가 파일과 다르다`);
    assert.equal(severity, meta(text, '심각도'), `${id}: 41종 목록 심각도가 파일과 다르다`);
  }
  assert.deepEqual([...seen].sort(), RUNBOOK_IDS, '41종 목록에 빠지거나 모르는 ID가 있다');
});

test('F0811-2 ② 증상별·원인 유형별 색인이 정본 9유형과 8증상을 덮는다', () => {
  const index = read('docs/runbooks/index.md');
  const symptoms = tableAfter(index, '증상별 색인');
  assert.ok(symptoms, 'index.md에 증상별 색인 표가 없다');
  assert.equal(symptoms.length, SYMPTOMS.length, `증상별 색인 행이 ${SYMPTOMS.length}개가 아니다`);
  for (const symptom of SYMPTOMS) {
    const row = symptoms.find((r) => r[0] === symptom);
    assert.ok(row, `증상별 색인에 '${symptom}' 행이 없다`);
    const ids = rbLinks(row[1]);
    assert.ok(ids.length > 0, `'${symptom}' 행에 런북 링크가 없다`);
  }

  const causes = tableAfter(index, '원인 유형별 색인');
  assert.ok(causes, 'index.md에 원인 유형별 색인 표가 없다');
  assert.equal(causes.length, CAUSES.length, `원인 유형별 색인 행이 ${CAUSES.length}개가 아니다`);
  assert.deepEqual(causes.map((r) => r[0]), CAUSES, '원인 유형 9가지의 이름·차례가 정본과 다르다');
  for (const [cause, cell] of causes) {
    const ids = rbLinks(cell);
    assert.ok(ids.length > 0, `'${cause}' 원인 유형에 런북이 없다`);
  }

  const canonical = read('docs/planning/03-policies-glossary.md');
  for (const cause of CAUSES) assert.ok(canonical.includes(cause), `정본 용어 사전에 '${cause}'가 없다`);
  const infra = read('docs/infra.md');
  const causeBlock = infra.split('\n').slice(infra.split('\n').findIndex((l) => l.includes('| 원인 유형 | 먼저 볼 런북 |')));
  const infraCauses = [];
  for (const line of causeBlock.slice(2)) {
    if (!line.startsWith('|')) break;
    const cause = line.split('|')[1].trim();
    if (!CAUSES.includes(cause)) break;
    infraCauses.push(cause);
  }
  assert.deepEqual(infraCauses, CAUSES, 'docs/infra.md §10 원인 유형 표가 정본 9가지와 다르다');
});

test('F0811-3 ① 인시던트 기준이 SEV1~3·탐지·에스컬레이션·포스트모템·경계를 정본 위치와 함께 둔다', () => {
  const text = read('docs/runbooks/incident-criteria.md');
  for (const title of ['심각도', '탐지 경로', '역할과 에스컬레이션', '포스트모템', '원인 유형', '공지', '경계']) {
    assert.ok(section(text, title), `incident-criteria.md에 '## ${title}' 절이 없다`);
  }
  assert.match(text, /\.\.\/observability\.md/, 'incident-criteria.md가 docs/observability.md를 가리키지 않는다');
  assert.match(text, /POL-022/, 'incident-criteria.md가 POL-022를 가리키지 않는다');
  for (const term of ['인시던트 지휘관', '운영 실행자', '기록·대외 공지 담당', '경보', '사람', '외부', '48시간']) {
    assert.ok(text.includes(term), `incident-criteria.md에 '${term}'이 없다`);
  }
  for (const cause of CAUSES) assert.ok(text.includes(cause), `incident-criteria.md에 원인 유형 '${cause}'가 없다`);
  const notice = section(text, '공지');
  for (const path of ['Upptime', '대기실', '파트너']) {
    assert.ok(notice.includes(path), `incident-criteria.md 공지에 '${path}' 경로가 없다`);
  }
  assert.match(section(text, '경계'), /미실행/, 'incident-criteria.md 경계에 미실행이 없다');

  const canon = read('docs/observability.md');
  for (const line of ['| SEV1 (치명적 장애)', '| SEV2 (주요 기능 장애)', '| SEV3 (경미한 장애)']) {
    assert.ok(canon.includes(line), `정본 docs/observability.md §5에 '${line}' 행이 없다`);
  }
  for (const term of ['인시던트 지휘관', '운영 실행자', '기록·대외 공지 담당']) {
    assert.ok(canon.includes(term), `정본 docs/observability.md §5에 '${term}'이 없다`);
  }
  for (const path of ['Upptime', '대기실', '파트너']) {
    assert.ok(canon.includes(path), `정본 docs/observability.md §5 공지에 '${path}'가 없다`);
  }
});

test('F0811-3 ② 인시던트 선언 7기준과 포스트모템 48시간이 정본과 같다', () => {
  const text = read('docs/runbooks/incident-criteria.md');
  const canon = read('docs/observability.md');
  const criteria = [
    [/SEV1/, /SEV1/],
    [/불변식 위반/, /불변식 위반/],
    [/명령 2·3·6/, /명령 2·3·6/],
    [/15분/, /15분/],
    [/예산 50%/, /예산 50%/],
    [/28일 예산의 20%/, /28일 예산의 20%/],
    [/사람이나 외부/, /사람이나 외부/],
  ];
  for (const [inDoc, inCanon] of criteria) {
    assert.match(text, inDoc, `incident-criteria.md에 선언 기준 ${inDoc}가 없다`);
    assert.match(canon, inCanon, `정본 docs/observability.md §5에 선언 기준 ${inCanon}가 없다`);
  }
  assert.match(section(text, '포스트모템'), /48시간/, 'incident-criteria.md 포스트모템에 48시간이 없다');
  assert.match(canon, /48시간 이내에 비난 없는 포스트모템/, '정본에 포스트모템 48시간이 없다');
  assert.match(section(text, '포스트모템'), /RB-17/, 'incident-criteria.md 포스트모템이 RB-17을 가리키지 않는다');
});

test('F0811-4 ① infra.md §10 표와 런북 파일의 ID·제목이 같고 표·경보 앵커가 파일을 가리킨다', () => {
  const infra = read('docs/infra.md');
  const heading = infra.split('\n').find((l) => /^## 10\. /.test(l));
  assert.ok(heading, 'docs/infra.md에 §10 제목이 없다');
  assert.ok(!heading.includes('예정'), `docs/infra.md §10 제목에 아직 '예정'이 있다: ${heading}`);
  const legacyAnchor = '10-런북-목차-예정-runbooks-작성-대상';
  assert.ok(infra.includes(`<a id="${legacyAnchor}"></a>`), `docs/infra.md §10에 옛 경보 앵커 <a id="${legacyAnchor}"></a>가 없다`);
  assert.ok(infra.includes('[RB-01](runbooks/RB-01.md)'), 'docs/infra.md §10의 RB-01이 runbooks/RB-01.md 링크가 아니다');

  const rulesDir = path.join(ROOT, 'deploy', 'platform', 'observability', 'rules');
  const urls = fs
    .readdirSync(rulesDir)
    .filter((f) => f.endsWith('.yaml'))
    .flatMap((f) => [...read(`deploy/platform/observability/rules/${f}`).matchAll(/runbook_url:\s*'([^']*docs\/infra\.md#[^']+)'/g)].map((m) => m[1]));
  assert.equal(urls.length, 13, `경보 13개의 docs/infra.md 앵커 URL이 아니다(${urls.length})`);
  for (const url of urls) {
    const fragment = url.split('#')[1];
    assert.ok(infra.includes(`<a id="${fragment}"></a>`), `경보 runbook_url 앵커가 §10에 없다: ${url}`);
  }

  const rows = infra
    .split('\n')
    .filter((l) => /^\|\s*\[?RB-\d\d\]?/.test(l))
    .map((l) => l.split('|').map((c) => c.trim()).filter(Boolean));
  assert.equal(rows.length, 41, `docs/infra.md §10의 RB 행이 41개가 아니다(${rows.length})`);
  for (const cells of rows) {
    const idMatch = cells[0].match(/^\[(RB-\d\d)\]\(runbooks\/(RB-\d\d)\.md\)$/);
    assert.ok(idMatch, `docs/infra.md §10의 ID 칸이 파일 링크가 아니다: ${cells[0]}`);
    assert.equal(idMatch[1], idMatch[2], `docs/infra.md §10의 ${idMatch[1]} 링크 대상이 다르다`);
    const text = read(`docs/runbooks/${idMatch[1]}.md`);
    const title = h1(text).replace(/^RB-\d\d: /, '');
    assert.ok(cells[1].startsWith(title), `${idMatch[1]}: §10 표의 명칭이 런북 제목 '${title}'으로 시작하지 않는다`);
  }

  const handover = read('docs/infra-handover.md');
  const handoverLine = handover.split('\n').find((l) => l.includes('런북 파일'));
  assert.ok(handoverLine, 'docs/infra-handover.md에 런북 파일 행이 없다');
  assert.ok(handoverLine.includes('docs/runbooks/'), 'docs/infra-handover.md 465행이 docs/runbooks/를 가리키지 않는다');
  assert.ok(!handoverLine.includes('목록만'), 'docs/infra-handover.md 465행이 아직 목록만이라고 적는다');
});

test('F0811-4 ② 담당 역할·목표 시간·포스트모템 판정과 HOT-010·inv-ref-key 절차가 모든 런북에 있다', () => {
  assertRunbookDir();
  for (const file of runbookFiles()) {
    const text = read(path.posix.join('docs/runbooks', file));
    assert.ok(ROLES.includes(meta(text, '담당')), `${file}: 담당 '${meta(text, '담당')}'이 역할 목록 밖이다`);
    assertTargetTime(file, meta(text, '목표 시간'));
    assert.match(section(text, '포스트모템'), /RB-17/, `${file}: 포스트모템 절이 RB-17을 가리키지 않는다`);
  }

  const rb05 = read('docs/runbooks/RB-05.md');
  assert.match(rb05, /identity\.accounts-withdrawn/, 'RB-05에 탈퇴 사건 토픽이 없다');
  assert.match(rb05, /20분/, 'RB-05에 장애 전환 시각 − 20분 되돌리기가 없다');

  const rb11 = read('docs/runbooks/RB-11.md');
  assert.match(rb11, /q:\{held:/, 'RB-11에 대기열 Redis 보류 키가 없다');
  assert.match(rb11, /held_event/, 'RB-11에 DB 보류 표 held_event가 없다');

  const rb26 = read('docs/runbooks/RB-26.md');
  for (const term of ['inv-ref-key', '회전 절차', '진행 중인 판매', '../security/secrets-and-keys.md']) {
    assert.ok(rb26.includes(term), `RB-26에 '${term}'이 없다`);
  }
});

test('F0811-5 ① 경계와 수치 미주장이 드러나고 41종에 30k/s·100만·K1/K2/K7 주장이 없다', () => {
  assertRunbookDir();
  const readme = read('docs/runbooks/README.md');
  assert.ok(readme.includes('미실행'), 'README.md에 미실행이 없다');
  for (const id of ['F-08-6', 'F-08-9', 'F-08-10', 'F-08-12', 'F-08-13']) {
    assert.ok(readme.includes(id), `README.md에 ${id} 경계가 없다`);
  }
  for (const claim of FORBIDDEN_CLAIMS) {
    assert.ok(readme.includes(claim), `README.md에 '${claim}'을 주장하지 않는다는 경계 문장이 없다`);
  }

  for (const file of [...runbookFiles(), 'index.md', 'incident-criteria.md']) {
    const text = read(path.posix.join('docs/runbooks', file));
    assertNoPositiveClaim(text, file);
    assertNoExecutionClaim(text, file);
  }
  for (const file of runbookFiles()) {
    const text = read(path.posix.join('docs/runbooks', file));
    assertPractice(section(text, '연습'), file);
  }
});

test('F0811-5 ② 런북의 상대 링크가 실재하고 관련 정본이 정본을 가리킨다', () => {
  assertRunbookDir();
  for (const file of runbookFiles()) {
    const text = read(path.posix.join('docs/runbooks', file));
    const found = links(text).filter((t) => !/^(https?:|mailto:|#)/.test(t));
    assert.ok(found.length > 0, `${file}: 상대 링크가 없다`);
    for (const target of found) {
      const rel = target.split('#')[0];
      if (!rel) continue;
      const resolved = path.resolve(path.join(ROOT, 'docs', 'runbooks'), rel);
      assert.ok(fs.existsSync(resolved), `${file}: 링크 대상이 없다: ${target}`);
    }
    const canonSection = section(text, '관련 정본');
    assert.ok(canonSection, `${file}: '## 관련 정본' 절이 없다`);
    const canon = links(canonSection);
    assert.ok(
      canon.some((t) => t.startsWith('../observability.md') || t.startsWith('../infra.md')),
      `${file}: 관련 정본이 ../observability.md 또는 ../infra.md를 가리키지 않는다`,
    );
    assert.ok(canon.length >= 2, `${file}: 관련 정본 링크가 2개 미만이다`);
    const outside = canon.some((t) => {
      const rel = t.split('#')[0];
      return rel.startsWith('../adr/') || rel.startsWith('../features/');
    });
    assert.ok(outside, `${file}: 관련 정본에 ../adr/ 또는 ../features/ 링크가 없다`);
  }
});
