// CloudFront Function(시청자 요청) 경로 PoC: 대기실 경로를 로케일 셸로 바꿔 읽는다(docs/infra.md §4 '대기실 경로', docs/frontend.md §5.1).
// 운영 배포는 AWS 계정이 생기는 단계(HOT-012·BAT-185)에서 한다. 이 파일은 CloudFront Functions 런타임 2.0의 ES 5.1 문법만 쓴다.
// - `/queue/{eventId}` → `/_q/shell.ko.html`
// - `/{en,ja,zh}/queue/{eventId}` → `/_q/shell.{locale}.html`
// - `/shop/{productId}/queue` → `/_q/shell.ko.html`
// 회차·상품 ID는 셸이 실행하는 스크립트가 location.pathname에서 읽으므로 URI를 그대로 둔다.
// querystring은 CloudFront Functions 이벤트에 이미 해석되어 있고, request.uri만 바꾸면 그대로 유지된다.

var SHELLS = {
  ko: '/_q/shell.ko.html',
  en: '/_q/shell.en.html',
  ja: '/_q/shell.ja.html',
  zh: '/_q/shell.zh.html',
};

function shellForUri(uri) {
  var event = /^\/(?:(en|ja|zh)\/)?queue\/[^/]+\/?$/.exec(uri);
  if (event) return SHELLS[event[1] || 'ko'];
  if (/^\/shop\/[^/]+\/queue\/?$/.test(uri)) return SHELLS.ko;
  return null;
}

function handler(event) {
  var request = event.request;
  var shell = shellForUri(request.uri);
  if (shell) request.uri = shell;
  return request;
}
