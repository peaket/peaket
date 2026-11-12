#!/usr/bin/env node
// 운영(출시 전에는 데모)에 올라간 이미지의 SBOM에서 패키지 이름·판을 찾는다(docs/devops.md §4.4 '조사 장치', ASVS 15.1.2, BUILD_ORDER BAS-020).
// deploy/의 환경 파일에서 image.digest를 읽고, 그 다이제스트의 CycloneDX SBOM(*.cdx.json)을 찾아 표를 낸다.
// 쓰는 법: node tools/ci/sbom-find.mjs --deploy deploy/envs --sbom sboms --package lodash [--version 4.17.20] [--fail-if-found]
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 배포 파일에서 이미지 이름과 다이제스트를 읽는다. `image.digest`(권장)와 `image: <digest>` 꼴을 받는다 */
export function deployedImages(text) {
  const doc = parse(text);
  const image = doc?.image;
  if (!image || typeof image !== 'object') return [];
  const digest = typeof image.digest === 'string' ? image.digest : typeof image === 'string' ? image : undefined;
  if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) return [];
  return [{ name: typeof doc.name === 'string' ? doc.name : basename('unknown'), digest }];
}

export function deployedFromDir(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ya?ml$/.test(e.name)) {
        try {
          out.push(...deployedImages(readFileSync(p, 'utf8')));
        } catch {
          // 배포 파일이 아니거나 읽지 못하면 건너뛴다
        }
      }
    }
  };
  walk(root);
  return out;
}

/** CycloneDX SBOM에서 구성요소를 찾는다. `metadata.component.name`이나 파일 이름이 이미지 이름과 같아야 한다 */
export function findInSbom(text, image) {
  const doc = JSON.parse(text);
  const components = Array.isArray(doc.components) ? doc.components : [];
  const where = doc?.metadata?.component?.name ?? '';
  return components
    .filter((c) => typeof c?.name === 'string')
    .map((c) => ({
      image: image.name,
      digest: image.digest,
      package: c.name,
      version: typeof c.version === 'string' ? c.version : '',
      purl: typeof c.purl === 'string' ? c.purl : '',
      where,
    }));
}

/** SBOM 폴더에서 배포 이미지의 다이제스트가 든 SBOM만 골라 패키지 이름(과 판)으로 거른다 */
export function findPackages({ deployed, sbomRoot, name, version }) {
  const rows = [];
  for (const file of readdirSync(sbomRoot).filter((f) => f.endsWith('.cdx.json'))) {
    const text = readFileSync(join(sbomRoot, file), 'utf8');
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      continue;
    }
    const component = doc?.metadata?.component;
    const digest = component?.properties?.find?.((p) => p.name === 'peaket:digest')?.value ?? component?.version ?? '';
    const image = deployed.find((d) => d.digest === digest) ?? deployed.find((d) => file.includes(d.name) || file.includes(d.digest.slice(7, 19)));
    if (!image) continue;
    rows.push(...findInSbom(text, image).filter((r) => r.package === name && (version === undefined || r.version === version)));
  }
  return rows;
}

export function formatRows(rows) {
  if (rows.length === 0) return '찾은 패키지가 없다';
  return ['| 환경 이미지 | 다이제스트 | 패키지 | 판 |', '| --- | --- | --- | --- |', ...rows.map((r) => `| ${r.image} | ${r.digest} | ${r.package} | ${r.version} |`)].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const value = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const deployRoot = value('--deploy', join(HERE, '..', '..', 'deploy', 'envs'));
  const sbomRoot = value('--sbom', join(HERE, '..', '..', 'sboms'));
  const pkg = value('--package');
  if (!pkg) {
    console.error('쓰는 법: node tools/ci/sbom-find.mjs --sbom <폴더> --package <이름> [--version <판>] [--deploy <폴더>] [--fail-if-found]');
    process.exit(2);
  }
  const rows = findPackages({ deployed: deployedFromDir(deployRoot), sbomRoot, name: pkg, version: value('--version') });
  console.log(formatRows(rows));
  if (args.includes('--fail-if-found') && rows.length > 0) process.exitCode = 1;
}
