// 프로토타입 오염을 막는 JSON 읽기(docs/security/asvs/frontend.md 15.3.6: `__proto__`·`constructor` 키는 공용 파서가 거절한다).
// 받은 JSON을 깊게 합치지 않는 것이 첫 장치이고, 이 파서는 그런 키가 든 값을 처음부터 받지 않는다.

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

export class UnsafeKeyError extends SyntaxError {
  constructor(readonly key: string) {
    super(`JSON에 쓸 수 없는 키가 있다: ${key}`);
    this.name = 'UnsafeKeyError';
  }
}

/** JSON.parse와 같되, 어느 깊이에든 __proto__·constructor·prototype 키가 있으면 UnsafeKeyError */
export function parseJsonSafe(text: string): unknown {
  return JSON.parse(text, function reviver(this: unknown, key: string, value: unknown) {
    if (UNSAFE.has(key)) throw new UnsafeKeyError(key);
    return value;
  });
}
