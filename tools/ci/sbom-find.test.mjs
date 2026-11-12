// SBOM에서 운영 이미지의 패키지 판을 찾는 도구(BUILD_ORDER BAS-020, ASVS 15.1.2, docs/devops.md §4.4) 시험.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployedFromDir, deployedImages, findPackages, formatRows } from './sbom-find.mjs';

const D = `sha256:${'a'.repeat(64)}`;
const E = `sha256:${'b'.repeat(64)}`;
const cdx = (name, digest, components) => JSON.stringify({ bomFormat: 'CycloneDX', metadata: { component: { name, version: digest, properties: [{ name: 'peaket:digest', value: digest }] } }, components });

test('[ASVS v5.0.0-15.1.2] BAS-020: 배포 파일의 image.digest를 읽고, 다이제스트가 맞는 SBOM에서만 패키지를 찾는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbom-find-'));
  try {
    const env = join(dir, 'envs', 'demo');
    const sboms = join(dir, 'sboms');
    mkdirSync(env, { recursive: true });
    mkdirSync(sboms, { recursive: true });
    writeFileSync(join(env, 'purchase-svc.yaml'), `name: purchase-svc\nimage:\n  repository: peaket/purchase-svc\n  digest: ${D}\n`);
    writeFileSync(join(env, 'ticket-svc.yaml'), `name: ticket-svc\nimage:\n  repository: peaket/ticket-svc\n  digest: ${E}\n`);
    writeFileSync(join(sboms, 'purchase-svc.cdx.json'), cdx('purchase-svc', D, [{ name: 'lodash', version: '4.17.20', purl: 'pkg:npm/lodash@4.17.20' }, { name: 'lodash-es', version: '4.17.21' }]));
    writeFileSync(join(sboms, 'ticket-svc.cdx.json'), cdx('ticket-svc', E, [{ name: 'lodash', version: '4.17.19' }]));
    assert.deepEqual(deployedImages('name: x\nimage:\n  digest: "not-a-digest"\n'), []);
    assert.deepEqual(deployedFromDir(join(dir, 'envs')), [{ name: 'purchase-svc', digest: D }, { name: 'ticket-svc', digest: E }]);
    const rows = findPackages({ deployed: deployedFromDir(join(dir, 'envs')), sbomRoot: sboms, name: 'lodash' });
    assert.deepEqual(rows.map((r) => [r.image, r.digest, r.package, r.version]), [
      ['purchase-svc', D, 'lodash', '4.17.20'],
      ['ticket-svc', E, 'lodash', '4.17.19'],
    ]);
    assert.equal(findPackages({ deployed: deployedFromDir(join(dir, 'envs')), sbomRoot: sboms, name: 'lodash', version: '4.17.20' }).length, 1);
    // 이름이 겹치는 패키지(lodash-es)는 'lodash'로 찾지 않는다
    assert.equal(rows.some((r) => r.package === 'lodash-es'), false);
    assert.match(formatRows(rows), /\| purchase-svc \|/);
    assert.match(formatRows([]), /찾은 패키지가 없다/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
