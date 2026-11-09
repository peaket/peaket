// 붙여넣은 HTML 거름(FE-T41, ADR-0204 결정 2): 해석 중 CSP 위반 보고가 나는 것(<style>·<script>·이벤트·style 속성·<img>)을 걷는다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { precleanPastedHtml } from './paste.ts';

test('스타일·스크립트·그림·주석·이벤트·style 속성을 걷고 글과 구조 꼬리표는 남긴다', () => {
  const html =
    '<html><head><meta charset="utf-8"><link rel="stylesheet" href="x.css"><style>p{color:red}</style></head><body><!--StartFragment-->' +
    '<h1 class="MsoTitle" style="color:#f00">제목</h1><p onclick="alert(1)" ONMOUSEOVER=\'x()\'>글<img src="https://evil.example/x.png" onerror="alert(1)"></p>' +
    '<script type="text/javascript">alert(1)</script><SCRIPT>alert(2)</SCRIPT><ul><li style=color:blue>항목</li></ul><!--EndFragment--></body></html>';
  const out = precleanPastedHtml(html);
  assert.doesNotMatch(out, /style|script|onclick|onmouseover|onerror|<img|<meta|<link|<!--|alert/i);
  assert.match(out, /<h1 class="MsoTitle">제목<\/h1><p>글<\/p><ul><li>항목<\/li><\/ul>/);
});

test('걷어 낸 자리에서 꼬리표가 되살아나지 않고, 꼬리표 밖 글자와 따옴표 안 값은 건드리지 않는다(새 맥락 리뷰 낮음 4)', () => {
  assert.doesNotMatch(precleanPastedHtml('<b o onclick="1"nclick="alert(1)">x</b>'), /onclick|alert/);
  assert.doesNotMatch(precleanPastedHtml('<scr<script></script>ipt>alert(1)</script>'), /<\/?script/i);
  assert.equal(precleanPastedHtml('<p>onion=3 style = bold</p>'), '<p>onion=3 style = bold</p>');
  assert.equal(precleanPastedHtml('<p title="a onclick=b" onclick="x">글</p>'), '<p title="a onclick=b">글</p>');
});

test('리뷰 재현: 굵기를 알리는 style 값만 남긴다(Google 문서는 전체를 <b style="font-weight:normal">로 감싼다)', () => {
  assert.equal(
    precleanPastedHtml('<b style="font-weight:normal;color:red"><span style="color:blue; font-weight: 700">굵게</span><span style=font-weight:400>보통</span></b>'),
    '<b style="font-weight:normal"><span style="font-weight:700">굵게</span><span style="font-weight:400">보통</span></b>',
  );
  assert.equal(precleanPastedHtml('<b style="mso-bidi-font-weight:normal">글</b>'), '<b>글</b>');
  assert.equal(precleanPastedHtml('<b style="font-weight:expression(alert(1))">글</b>'), '<b>글</b>');
});

test('리뷰 재현: 닫는 꼬리표 없는 큰 입력도 금방 끝난다', () => {
  for (const unit of ['<a ', '<style ', '<script ', '<img ']) {
    const started = performance.now();
    precleanPastedHtml(unit.repeat(40_000));
    assert.ok(performance.now() - started < 1_000, `${unit}: ${Math.round(performance.now() - started)}ms`);
  }
});

test('닫는 꼬리표가 있으면 덩어리를 걷는다(대소문자·공백)', () => {
  assert.equal(precleanPastedHtml('<p>앞</p><STYLE>p{}</style ><p>뒤</p><script>a</SCRIPT>'), '<p>앞</p><p>뒤</p>');
});
