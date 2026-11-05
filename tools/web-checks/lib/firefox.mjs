// Playwright 설정들의 Firefox 프로젝트 값(docs/frontend.md §5.17). 기본은 Playwright가 고친 Firefox 판이고, CI·컨테이너(lib/docker.mjs)와 같다.
// 이 PC(Windows)처럼 그 판이 side-by-side 구성 오류로 뜨지 않으면(2026-11-04, mozglue 어셈블리를 찾지 못함) PEAKET_FIREFOX=system으로
// 설치한 정식 Firefox를 WebDriver BiDi(표준 원격 조종, Playwright의 moz-firefox 채널, 실험 기능)로 띄운다.
// - Windows의 정식 Firefox는 시작 프로세스가 브라우저 프로세스를 띄우고 곧 끝나서, 끝난 것으로 보고 실패한다. -wait-for-browser로 기다린다.
// - 정식 판은 CI 판과 엔진 판·조종 방식이 다르다. 결과 기록에 어느 쪽으로 쟀는지 적는다.
import { devices } from '@playwright/test';

/**
 * PEAKET_FIREFOX 값을 읽는다. 없으면 Playwright 판, 'system'이면 설치한 정식 Firefox. 그 밖의 값은 멈춘다(틀린 값을 조용히 무시하지 않는다)
 * @param {string | undefined} raw
 * @returns {'playwright' | 'system'}
 */
export function firefoxKind(raw) {
  if (raw === undefined || raw === '') return 'playwright';
  if (raw === 'system') return 'system';
  throw new Error(`PEAKET_FIREFOX는 비우거나 system이어야 한다(받은 값 ${JSON.stringify(raw)})`);
}

/**
 * Firefox 프로젝트의 use 값. 기기 값(Desktop Firefox) 위에 설정마다의 값(화면 크기 등)을 얹는다
 * @param {Record<string, any>} [extra]
 * @param {{ kind?: 'playwright' | 'system', platform?: string }} [opts] 시험용(기본은 환경 변수와 이 PC)
 */
export function firefoxUse(extra = {}, { kind = firefoxKind(process.env.PEAKET_FIREFOX), platform = process.platform } = {}) {
  const use = { ...devices['Desktop Firefox'], ...extra };
  if (kind === 'playwright') return use;
  const args = [...(use.launchOptions?.args ?? []), ...(platform === 'win32' ? ['-wait-for-browser'] : [])];
  return { ...use, channel: 'moz-firefox', launchOptions: { ...use.launchOptions, args } };
}

/**
 * 설치한 정식 Firefox를 BiDi로 띄웠는가. Playwright 1.64.1의 BiDi는 몇 가지를 주지 않는다(2026-11-05 이 PC에서 확인):
 * prefers-color-scheme 흉내(colorScheme), 보낸 요청의 본문(request.postData). 그 단언만 이 경우에 건너뛰고 까닭을 남긴다
 * @param {string} browserName
 */
export const isBidiFirefox = (browserName, kind = firefoxKind(process.env.PEAKET_FIREFOX)) => browserName === 'firefox' && kind === 'system';
