// BAT-210 문서 묶음(BAS-070 운영 확인 표, BAS-110 NFR-007 셈 근거, BAS-230 RFC 초안)의 정적 시험.
// 문장을 고칠 때 표·근거·초안이 통째로 사라지는 것을 막는다. 숫자의 실제 성능 판정은 측정 몫이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FEATURES = join(REPO, 'docs', 'features');
const COLUMNS = ['확인할 동작', '사건·필드', 'SLI', '대시보드 패널', '경보', '배포 뒤 확인 방법'];

test('BAS-070 기능 설계서는 운영 확인 표(6칸)를 갖는다', () => {
  const docs = readdirSync(FEATURES).filter((f) => f.endsWith('.md') && f !== 'README.md').sort();
  assert.ok(docs.length >= 13, `기능 설계서가 ${docs.length}편뿐이다`);
  for (const file of docs) {
    const text = readFileSync(join(FEATURES, file), 'utf8');
    assert.match(text, /운영 확인/, `${file}: 운영 확인 설명이 없다`);
    const header = text.split(/\r?\n/).find((line) => COLUMNS.every((c) => line.includes(c)));
    assert.ok(header, `${file}: 운영 확인 표의 머리(6칸)가 없다`);
  }
  // 서비스 템플릿 자체의 표도 남아 있어야 한다.
  const observability = readFileSync(join(REPO, 'docs', 'observability.md'), 'utf8');
  assert.match(observability, /서비스 템플릿의 운영 확인/);
  assert.ok(observability.split(/\r?\n/).some((line) => COLUMNS.every((c) => line.includes(c))));
});

test('BAS-110 30만 RPS의 셈 근거가 architecture §9.1과 verification §4에 있다', () => {
  const architecture = readFileSync(join(REPO, 'docs', 'architecture.md'), 'utf8');
  assert.match(architecture, /NFR-007의 30만 RPS 근거/);
  assert.match(architecture, /100만 × 0\.3 × 2 ÷ 10초/);
  assert.match(architecture, /6만 × 5 = 30만 RPS/);
  assert.match(architecture, /100만 명 × 10건 \[가정\] = 1,000만 건/);
  const verification = readFileSync(join(REPO, 'docs', 'verification.md'), 'utf8');
  assert.match(verification, /30만 RPS\(NFR-007, 100만 × 30% × 2회 ÷ 10초 × 5건 \[가정\]/);
  assert.match(verification, /`webhook-id`·`webhook-timestamp`·`webhook-signature` 세 머리와 5분 창/);
  assert.match(architecture, /45만 \[가정\]으로 올린다/);
});

test('BAS-230 RFC 초안 3건과 색인이 있다', () => {
  const dir = join(REPO, 'docs', 'rfc');
  const index = readFileSync(join(dir, 'README.md'), 'utf8');
  for (const [file, title] of [
    ['0001-onsale-hot-path.md', '온세일 핫패스'],
    ['0002-bot-defense.md', '봇 방어'],
    ['0003-control-tower.md', '관제'],
  ]) {
    const path = join(dir, file);
    assert.ok(existsSync(path), `${file}: 없다`);
    const text = readFileSync(path, 'utf8');
    assert.match(text, new RegExp(`^# RFC \\d{4}: .*${title}`), `${file}: 제목`);
    assert.match(text, /- \*\*상태\*\*: 초안\(2026-11-12/, `${file}: 상태`);
    for (const heading of ['## 1.', '## 2.', '## 3.']) assert.match(text, new RegExp(`^${heading}`, 'm'), `${file}: ${heading}`);
    assert.match(index, new RegExp(`\\]\\(${file.replace('.', '\\.')}\\)`), `${file}: 색인 링크`);
  }
});
