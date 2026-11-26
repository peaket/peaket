// F-04-16 운영·시험 빌드 갈래와 COOP/COEP 헤더 시험. 정본: docs/frontend.md §5.14.1(묶음 G·C+COEP),
// docs/features/forensic-replay.md §6.8, docs/security/asvs/forensic-replay.md(v5.0.0-3.4.8·3.5.4),
// docs/design/d5 §7.17. 운영 모듈이 없으면 시험마다 단언으로 실패하게 동적 import를 쓴다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

async function load() {
  try {
    return await import('./build.ts');
  } catch {
    return null;
  }
}

const build = await load();

function need(name) {
  assert.ok(build, '빌드 갈래 모델(src/lib/build.ts)이 없다');
  assert.equal(typeof build[name], 'function', `${name}이 없다`);
  return build[name];
}

test('FX-T17 ① 빌드 모드는 PEAKET_FORENSICS_MODE=operating일 때만 운영이고 모르는 값은 거절한다', () => {
  const mode = need('forensicsMode');
  assert.equal(mode({}), 'demo');
  assert.equal(mode({ PEAKET_FORENSICS_MODE: 'demo' }), 'demo');
  assert.equal(mode({ PEAKET_FORENSICS_MODE: 'operating' }), 'operating');
  assert.throws(() => mode({ PEAKET_FORENSICS_MODE: 'prod' }), /PEAKET_FORENSICS_MODE/);
  assert.throws(() => mode({ PEAKET_FORENSICS_MODE: 'Operating' }), /PEAKET_FORENSICS_MODE/);
});

test('FX-T17 ① 운영 빌드는 operating.html과 /forensics/ 기반 경로를 쓰고 시험·시연은 index.html이다', () => {
  const input = need('forensicsInput');
  const base = need('forensicsBase');
  assert.deepEqual(input('operating'), { forensics: 'operating.html' });
  assert.deepEqual(input('demo'), { index: 'index.html' });
  assert.equal(base('operating'), '/forensics/');
  assert.equal(base('demo'), '/');
});

test('FX-T17 ① vite.config는 개발·미리보기 서버에 COOP same-origin·COEP require-corp를 건다', () => {
  const dev = need('forensicsDevHeaders');
  const preview = need('forensicsPreviewHeaders');
  for (const mode of ['demo', 'operating']) {
    assert.equal(dev(mode)['Cross-Origin-Opener-Policy'], 'same-origin', `${mode} COOP`);
    assert.equal(dev(mode)['Cross-Origin-Embedder-Policy'], 'require-corp', `${mode} COEP`);
    assert.equal(dev(mode)['Referrer-Policy'], 'no-referrer', `${mode} Referrer-Policy`);
    assert.equal(preview(mode)['Cross-Origin-Opener-Policy'], 'same-origin', `${mode} preview COOP`);
    assert.equal(preview(mode)['Cross-Origin-Embedder-Policy'], 'require-corp', `${mode} preview COEP`);
  }
});

test('[ASVS v5.0.0-3.4.8] 데모 미리보기는 묶음 G, 운영 미리보기는 콘솔 묶음 C에 COEP를 더한다', () => {
  const preview = need('forensicsPreviewHeaders');
  const demo = preview('demo')['Content-Security-Policy'];
  const operating = preview('operating')['Content-Security-Policy'];
  assert.match(demo, /connect-src 'self'/);
  assert.doesNotMatch(demo, /ops-api/);
  assert.match(operating, /ops-api/);
  assert.match(operating, /frame-ancestors 'none'/);
  assert.equal(preview('operating')['Cross-Origin-Embedder-Policy'], 'require-corp');
  // 배포(deploy/) 연결은 동결 밖이다. 이 시험은 생성기·개발·미리보기 헤더까지만 본다(계획 §6·§14)
});

test('[ASVS v5.0.0-3.5.4] 운영 빌드는 콘솔과 같은 출처의 /forensics/ 아래에 둔다', () => {
  const base = need('forensicsBase');
  const mode = need('forensicsMode');
  assert.equal(mode({ PEAKET_FORENSICS_MODE: 'operating' }), 'operating');
  assert.equal(base('operating'), '/forensics/', '운영 빌드는 콘솔 출처 아래 /forensics/에 둔다');
  assert.equal(base('demo'), '/', '시험·시연 빌드는 따로 연 공개 위치의 뿌리에 둔다');
});

test('FX-T17 ① vite.config가 빌드 갈래·헤더 함수를 실제로 쓴다', () => {
  const config = readFileSync('vite.config.ts', 'utf8');
  for (const name of ['forensicsMode', 'forensicsInput', 'forensicsBase', 'forensicsDevHeaders', 'forensicsPreviewHeaders']) {
    assert.match(config, new RegExp(`\\b${name}\\(`), `vite.config.ts가 ${name}(을)를 부르지 않는다`);
  }
  assert.match(config, /server:\s*\{[^}]*headers:\s*forensicsDevHeaders\(/s);
  assert.match(config, /preview:\s*\{[^}]*headers:\s*forensicsPreviewHeaders\(/s);
  // 운영 묶음의 진입점은 반드시 forensicsInput(mode)에서 온다(RV0416-03)
  assert.match(config, /rolldownOptions:\s*\{[^}]*input:\s*forensicsInput\(/s, 'build.rolldownOptions.input이 forensicsInput(mode)을 쓰지 않는다');
});
