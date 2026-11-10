// 화면 보안 린트(docs/security/asvs/delivery.md 3.2.2·3.5.5, docs/devops.md §4.4 '보안 린트', ADR-0259 결정 10·12, ADR-0253, BUILD_ORDER BAS-010 ①).
// 새 패키지(eslint-plugin-react의 react/no-danger, Semgrep) 없이 이 파일에 직접 만든 ESLint 규칙(peaket-web/*)이 구문(노드 종류와 이름)을 보고 막는다.
// no-restricted-syntax를 쓰지 않는 까닭: 같은 규칙 이름을 다른 설정 묶음(뿌리의 목업 금지)이 함께 쓰면 뒤의 묶음이 앞의 선택자 목록을 통째로 덮는다.
// 이름은 글자 그대로(Literal)·식 없는 템플릿 글자로 쓴 것을 보고, 형 단언(as·satisfies·<T>·!)은 벗겨 본다. 별칭(const w = window)은 따라가지 않는다.
// - peaket-web/no-html-injection: HTML을 넣는 곳(dangerouslySetInnerHTML, innerHTML·outerHTML 대입과 Object.assign·Reflect.set,
//   insertAdjacentHTML·document.write(ln), setHTMLUnsafe·parseHTMLUnsafe·createContextualFragment·DOMParser.parseFromString 호출, iframe srcdoc, setAttribute의 srcdoc·on…).
//   글은 textContent나 React 글자 자식으로 그린다.
// - peaket-web/no-window-message: 창 message 수신기(addEventListener('message')·onmessage). 처음에는 뿌리 eslint.config.mjs의 NO_WINDOW_MESSAGE였다.
// 이 규칙을 줄 안 주석(eslint-disable 등)으로 끄면 tools/ci/check-lint-disables.mjs가 막는다. 예외는 아래 허용 목록(파일과 까닭)으로만 둔다.
import tsParser from '@typescript-eslint/parser';

const WHY_HTML = 'HTML을 넣지 않는다. 글은 textContent나 React 글자 자식으로 그린다(ASVS 3.2.2, ADR-0259)';
const WHY_MESSAGE = '창 메시지(message) 수신기를 두지 않는다. 결제 결과 등은 복귀 주소의 값을 서버가 대조해 정한다(ASVS 3.5.5, ADR-0253)';

/** 항목 ID → 글. 예외는 항목 ID로 푼다 */
export const HTML_INJECTION_SINKS = {
  dangerouslySetInnerHTML: { message: `dangerouslySetInnerHTML로 ${WHY_HTML}` },
  innerHTML: { message: `innerHTML·outerHTML에 넣어(대입·Object.assign·Reflect.set) ${WHY_HTML}` },
  insertAdjacentHTML: { message: `insertAdjacentHTML로 ${WHY_HTML}` },
  documentWrite: { message: `document.write(ln)으로 ${WHY_HTML}` },
  unsafeHtmlParse: { message: `setHTMLUnsafe·parseHTMLUnsafe·createContextualFragment로 ${WHY_HTML}` },
  // 해석한 문서의 노드를 화면에 옮기면 그 안의 on… 속성이 돈다(다시 보기 S2)
  domParser: { message: `DOMParser.parseFromString으로 HTML을 해석해 ${WHY_HTML}` },
  srcdoc: { message: `iframe srcdoc으로 ${WHY_HTML}` },
  eventHandlerAttribute: { message: 'setAttribute로 on… 이벤트 속성(글로 된 스크립트)을 넣지 않는다. 처리기는 addEventListener로 단다(ASVS 3.2.2, ADR-0259)' },
};
export const WINDOW_MESSAGE_LISTENERS = { windowMessage: { message: WHY_MESSAGE } };

const TS_WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'TSNonNullExpression']);
/** 형 단언을 벗긴다 */
function unwrap(node) {
  let n = node;
  while (n && TS_WRAPPERS.has(n.type)) n = n.expression;
  return n;
}
/** 글자 그대로 정해진 문자열 값(Literal·식 없는 템플릿 글자). 아니면 null */
function staticString(node) {
  const n = unwrap(node);
  if (n?.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n?.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis[0].value.cooked;
  return null;
}
/** 멤버 식(a.b, a['b'], a[`b`])의 이름. 계산되는 이름이면 null */
const memberName = (m) => (m.computed ? staticString(m.property) : m.property.type === 'Identifier' ? m.property.name : null);
/** 객체 칸(b:, 'b':, ['b']:, [`b`]:, 단축 b)의 이름 */
const keyName = (p) => (p.computed ? staticString(p.key) : p.key.type === 'Identifier' ? p.key.name : staticString(p.key));
function calleeMember(call) {
  const c = unwrap(call.callee);
  return c?.type === 'MemberExpression' ? c : null;
}
function isNamed(node, re) {
  const n = unwrap(node);
  return n?.type === 'Identifier' && re.test(n.name);
}
const WINDOW = /^(window|self|globalThis|parent|top)$/;

/** 넣는 곳 이름 → 항목 ID(대입·Object.assign·Reflect.set이 같다) */
const propertySink = (name) => (name === 'innerHTML' || name === 'outerHTML' ? 'innerHTML' : name === 'srcdoc' ? 'srcdoc' : null);
/** 속성 이름(대소문자 무시) → 항목 ID */
function attributeSink(name) {
  const a = typeof name === 'string' ? name.toLowerCase() : null;
  if (a === 'srcdoc') return 'srcdoc';
  return a && /^on[a-z]/.test(a) ? 'eventHandlerAttribute' : null;
}

/** 규칙 하나: 노드 종류마다 찾는 함수가 항목 ID를 내면 알린다. 선택 칸 allow: 푸는 항목 ID */
function sinkRule(sinks, description, visitors) {
  const ids = Object.keys(sinks);
  return {
    meta: {
      type: 'problem',
      docs: { description },
      schema: [{ type: 'object', properties: { allow: { type: 'array', items: { enum: ids }, uniqueItems: true } }, additionalProperties: false }],
    },
    create(context) {
      const allow = new Set(context.options[0]?.allow ?? []);
      const report = (node, id) => {
        if (id && !allow.has(id)) context.report({ node, message: sinks[id].message });
      };
      return Object.fromEntries(Object.entries(visitors).map(([type, fn]) => [type, (node) => fn(node, report)]));
    },
  };
}

const htmlVisitors = {
  JSXAttribute(node, report) {
    const n = node.name.type === 'JSXIdentifier' ? node.name.name : null;
    if (n === 'dangerouslySetInnerHTML') report(node, 'dangerouslySetInnerHTML');
    else if (n?.toLowerCase() === 'srcdoc') report(node, 'srcdoc');
  },
  // 객체 글자의 칸: dangerouslySetInnerHTML(createElement 속성·펼칠 속성 묶음)과, Object.assign 원본의 innerHTML·outerHTML·srcdoc.
  // 구조 분해(ObjectPattern)로 떼어 내는 쪽은 막지 않는다
  Property(node, report) {
    if (node.parent.type !== 'ObjectExpression') return;
    const k = keyName(node);
    if (k === 'dangerouslySetInnerHTML') return report(node, 'dangerouslySetInnerHTML');
    const call = node.parent.parent;
    const m = call?.type === 'CallExpression' ? calleeMember(call) : null;
    if (m && isNamed(m.object, /^Object$/) && memberName(m) === 'assign' && call.arguments.indexOf(node.parent) >= 1) report(node, propertySink(k));
  },
  AssignmentExpression(node, report) {
    const left = unwrap(node.left);
    if (left?.type === 'MemberExpression') report(node, propertySink(memberName(left)));
  },
  CallExpression(node, report) {
    const m = calleeMember(node);
    if (!m) return;
    const name = memberName(m);
    const args = node.arguments;
    if (name === 'insertAdjacentHTML') return report(node, 'insertAdjacentHTML');
    if (name === 'setHTMLUnsafe' || name === 'parseHTMLUnsafe' || name === 'createContextualFragment') return report(node, 'unsafeHtmlParse');
    if (name === 'parseFromString') return report(node, 'domParser');
    if (name === 'write' || name === 'writeln') {
      const obj = unwrap(m.object);
      if (isNamed(obj, /^document$/) || (obj?.type === 'MemberExpression' && memberName(obj) === 'document')) report(node, 'documentWrite');
      return;
    }
    if (name === 'setAttribute') return report(node, attributeSink(staticString(args[0])));
    if (name === 'setAttributeNS') return report(node, attributeSink(staticString(args[1])));
    if (name === 'set' && isNamed(m.object, /^Reflect$/)) report(node, propertySink(staticString(args[1])));
  },
};

const messageVisitors = {
  CallExpression(node, report) {
    if (staticString(node.arguments[0]) !== 'message') return;
    const callee = unwrap(node.callee);
    if (callee?.type === 'Identifier' && callee.name === 'addEventListener') return report(node, 'windowMessage');
    if (callee?.type === 'MemberExpression' && memberName(callee) === 'addEventListener' && isNamed(callee.object, WINDOW)) report(node, 'windowMessage');
  },
  AssignmentExpression(node, report) {
    const left = unwrap(node.left);
    if (left?.type === 'Identifier' && left.name === 'onmessage') return report(node, 'windowMessage');
    if (left?.type === 'MemberExpression' && memberName(left) === 'onmessage' && isNamed(left.object, WINDOW)) report(node, 'windowMessage');
  },
};

export const webSecurityPlugin = {
  rules: {
    'no-html-injection': sinkRule(HTML_INJECTION_SINKS, '화면 코드가 HTML을 넣는 곳을 막는다(ASVS 3.2.2)', htmlVisitors),
    'no-window-message': sinkRule(WINDOW_MESSAGE_LISTENERS, '화면 코드의 창 메시지 수신기를 막는다(ASVS 3.5.5)', messageVisitors),
  },
};

/**
 * 이름을 단 예외(파일 하나, 푸는 항목, 까닭). 정화한 HTML을 해석하거나, 해석한 문서를 화면에 붙이지 않고 읽기만 하는 곳만 둔다.
 * 화면에 HTML을 넣는 예외는 없다: 공연 설명(catalog-review 1.3.1)은 HTML이 아니라 허용 노드만 담은 구조 문서로 받고 web이 노드마다
 * React 요소로 그려 HTML을 넣지 않는다(HOT-185). 공연 상세의 JSON-LD도 글자 자식으로 싣는다(EventDetailPage, asvs/frontend.md 1.2.1).
 * 아래 둘은 DOMParser 항목(다시 보기 S2, 2026-11-10)을 더할 때 이미 있던 쓰임이다.
 * @type {{ file: string, allow: (keyof typeof HTML_INJECTION_SINKS | keyof typeof WINDOW_MESSAGE_LISTENERS)[], reason: string }[]}
 */
export const WEB_SECURITY_EXCEPTIONS = [
  {
    file: 'apps/partner/src/features/rich-text/LexicalEditor.tsx',
    allow: ['domParser'],
    reason: '공연 설명 편집기(catalog-review 1.3.1, HOT-185)가 붙여넣은 HTML을 걷어 낸 뒤(paste.ts의 pasteHtml, Trusted Types 정책 peaket-paste) 해석해 등록한 Lexical 노드만 넣는다. 해석한 문서는 화면에 붙이지 않는다',
  },
  {
    file: 'apps/console-host/src/app/RouteError.tsx',
    allow: ['domParser'],
    reason: '같은 출처의 index.html을 해석해 첫 화면 묶음 파일 이름(새 배포 여부)만 읽는다. 해석한 문서는 화면에 붙이지 않는다',
  },
];

/** 화면 보안 규칙이 보지 않는 파일: Node에서 도는 시험과 이야기(Storybook). 뿌리의 목업 금지와 같은 범위다 */
export const WEB_SECURITY_IGNORES = ['**/*.test.*', '**/*.spec.*', '**/*.stories.*'];

function checkExceptions(exceptions) {
  const known = { 'no-html-injection': Object.keys(HTML_INJECTION_SINKS), 'no-window-message': Object.keys(WINDOW_MESSAGE_LISTENERS) };
  return exceptions.map((e) => {
    if (typeof e.file !== 'string' || !/^[\w@./-]+$/.test(e.file) || e.file.includes('*')) throw new TypeError(`화면 보안 예외는 파일 하나를 경로로 적는다: ${e.file}`);
    if (typeof e.reason !== 'string' || e.reason.trim() === '') throw new TypeError(`화면 보안 예외에 까닭이 없다: ${e.file}`);
    if (!Array.isArray(e.allow) || e.allow.length === 0) throw new TypeError(`화면 보안 예외에 푸는 항목이 없다: ${e.file}`);
    const byRule = {};
    for (const id of e.allow) {
      const rule = Object.keys(known).find((r) => known[r].includes(id));
      if (!rule) throw new TypeError(`화면 보안 예외의 모르는 항목: ${id} (${e.file})`);
      (byRule[rule] ??= []).push(id);
    }
    return { file: e.file, byRule };
  });
}

/**
 * @param {string[]} files 화면 코드 글롭
 * @param {{ exceptions?: typeof WEB_SECURITY_EXCEPTIONS, ignores?: string[] }} [o]
 * @returns {import('eslint').Linter.Config[]}
 */
export function webSecurityConfigs(files, { exceptions = WEB_SECURITY_EXCEPTIONS, ignores = WEB_SECURITY_IGNORES } = {}) {
  const checked = checkExceptions(exceptions);
  return [
    {
      files,
      ignores,
      languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' } },
      plugins: { 'peaket-web': webSecurityPlugin },
      rules: { 'peaket-web/no-html-injection': 'error', 'peaket-web/no-window-message': 'error' },
    },
    ...checked.map(({ file, byRule }) => ({
      files: [file],
      rules: Object.fromEntries(Object.entries(byRule).map(([rule, allow]) => [`peaket-web/${rule}`, ['error', { allow }]])),
    })),
  ];
}
