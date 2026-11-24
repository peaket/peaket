// F-04-8 하네스가 쓰는 빌드된 작업 공간 모듈을 찾는다.
// loadtest/에는 @peaket/* 의존성이 없으므로 서비스의 package.json을 기준으로 resolve한다(서비스는 workspace 의존성을 갖는다).
// 실행 전에 `pnpm exec turbo run build --filter=@peaket/contracts --filter=@peaket/platform ...`이 필요하다.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const anchor = new URL('../../services/analytics-ingest/package.json', import.meta.url);
const requireFromService = createRequire(anchor);

/** @param {string} spec */
async function importResolved(spec) {
  const path = requireFromService.resolve(spec);
  return import(pathToFileURL(path).href);
}

export async function loadPlatform() {
  return importResolved('@peaket/platform/stream-worker');
}

export async function loadAvro() {
  return importResolved('@peaket/platform/avro');
}

export async function loadContracts() {
  return importResolved('@peaket/contracts/avro');
}

/** avsc는 서비스의 의존성이다(loadtest에는 없다) */
export function loadAvsc() {
  return requireFromService('avsc');
}
