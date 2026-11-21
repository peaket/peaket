// 셸 명령 글을 '명령 하나 = 낱말 목록'으로 가른다(ADR-0330). Bash(POSIX sh)와 PowerShell 둘 다 대충 같은 꼴로 읽는다.
// 완전한 셸 해석기가 아니다: 따옴표·구분자(; && || | & 줄바꿈 괄호 $( )·heredoc·PowerShell here-string만 안다.
// heredoc과 here-string 본문은 명령이 아니라 자료라서 따로 빼 둔다. 커밋 메시지에 'git add -A'라고 적어도 막히지 않게 하려는 것이다.

const HEREDOC = /<<-?[ \t]*(['"]?)([A-Za-z_][\w-]*)\1([^\n]*)\n([\s\S]*?)(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g;
const HERESTRING = /@(['"])[ \t]*\r?\n([\s\S]*?)\r?\n\1@/g;

export function parseCommand(command) {
  const heredocs = [];
  const herestrings = [];
  let text = String(command ?? '').replace(/\r\n/g, '\n');
  text = text.replace(HERESTRING, (_, _q, body) => {
    herestrings.push(body);
    return ` @@HS${herestrings.length - 1}@@ `;
  });
  text = text.replace(HEREDOC, (_, _q, _tag, rest, body) => {
    heredocs.push(body);
    return `<<@@HD${heredocs.length - 1}@@${rest}`;
  });
  return { segments: splitSegments(text), heredocs, herestrings };
}

function splitSegments(text) {
  const segments = [];
  let words = [];
  let word = null; // null이면 낱말 밖
  let quote = null;
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) word += text[++i];
      else if (c === '"') quote = null;
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      if (word === null) word = '';
      continue;
    }
    if (c === '$' && text[i + 1] === '(') {
      endSegment();
      i++;
      continue;
    }
    if (c === ';' || c === '\n' || c === '|' || c === '&' || c === '(' || c === ')' || c === '{' || c === '}') {
      endSegment();
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      continue;
    }
    word = (word ?? '') + c;
  }
  endSegment();
  return segments;
}

const ENV_ASSIGN = /^[A-Za-z_]\w*=/;
const PREFIX = new Set(['sudo', 'command', 'exec', 'env', 'time', 'nohup']);

// 낱말 목록에서 실제 실행 파일 이름(소문자, 경로·.exe·.cmd 뗌)과 그 뒤 인자
export function program(words) {
  let i = 0;
  while (i < words.length && (ENV_ASSIGN.test(words[i]) || PREFIX.has(words[i]))) i++;
  if (i >= words.length) return null;
  const name = words[i].split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
  return { name, args: words.slice(i + 1) };
}

// git 전역 옵션(-C 폴더, -c 키=값 등)을 넘기고 하위 명령과 그 인자, -C 폴더를 돌려준다
export function gitCall(args) {
  let i = 0;
  let dir = null;
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    if (a === '-C') {
      dir = args[i + 1] ?? null;
      i += 2;
    } else if (a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') {
      i += 2;
    } else i++;
  }
  if (i >= args.length) return null;
  return { sub: args[i], args: args.slice(i + 1), dir };
}
