// @peaket/validation 시험(docs/frontend.md §2.2 '생성물', docs/security/asvs/frontend.md 15.3.6, BUILD_ORDER BAS-210)
import { describe, expect, it } from 'vitest';
import { parseJsonSafe, UnsafeKeyError, queue, seats } from '../src/index';

describe('안전한 JSON 읽기', () => {
  it('[ASVS v5.0.0-15.3.6] __proto__·constructor·prototype 키는 어느 깊이에 있어도 거절한다', () => {
    for (const text of ['{"__proto__":{"admin":true}}', '{"a":{"constructor":{"prototype":{"x":1}}}}', '[{"ok":1},{"prototype":2}]']) {
      expect(() => parseJsonSafe(text)).toThrow(UnsafeKeyError);
    }
  });

  it('[ASVS v5.0.0-15.3.6] 보통 JSON은 그대로 읽고, 키 이름에 그 글자가 들어갈 뿐인 것은 받는다', () => {
    expect(parseJsonSafe('{"a":[1,{"b":"__proto__"}],"constructorName":"x"}')).toEqual({ a: [1, { b: '__proto__' }], constructorName: 'x' });
  });
});

describe('계약 스키마 다시 내보내기', () => {
  it('요청·응답 Zod는 계약 패키지의 생성 스키마를 태그별로 다시 내보낸다', () => {
    expect(Object.keys(queue).length).toBeGreaterThan(0);
    expect(Object.keys(seats).length).toBeGreaterThan(0);
  });
});
