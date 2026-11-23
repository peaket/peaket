// 관제 콘솔 SCR-053 등록 QR(`/enroll#code=…`)을 받는 함수(offline-gate §6.1 'GAT-170 마감 규칙' 마지막 줄, 계획 F-05-5 §10의 4).
// 코드는 주소 조각(#)에만 실려 서버·기록에 남지 않는다. 화면은 이 값을 입력 칸에만 넣고 어떤 저장소에도 쓰지 않으며, 읽은 뒤 주소창에서 지운다.
// node --test가 형식 지우기만으로 읽으므로 이 파일은 가져오기·매개변수 속성 없이 쓴다.

/** 풀린 등록 코드의 최대 글자 수(이보다 길면 받지 않는다) */
const MAX_CODE_LENGTH = 64;

const fieldsOf = (hash: string): string[] => {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  return raw === "" ? [] : raw.split("&");
};

const isCodeField = (field: string): boolean => field === "code" || field.startsWith("code=");

/** 조각의 첫 `code=` 칸 값을 푼다. 없거나 비었거나 깨졌거나 65자 이상이면 undefined(던지지 않는다) */
export function enrollmentCodeFromHash(hash: string): string | undefined {
  const field = fieldsOf(hash).find(isCodeField);
  if (field === undefined) return undefined;
  const raw = field.slice("code=".length);
  if (raw === "") return undefined;
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  if (value === "" || value.length > MAX_CODE_LENGTH) return undefined;
  return value;
}

/** 조각에 `code` 칸이 있으면(값이 깨져도) 주소를 경로+검색어로 한 번 바꿔 조각을 지운다. 없으면 건드리지 않는다 */
export function stripEnrollmentFragment(loc: { pathname: string; search: string; hash: string }, replace: (url: string) => void): void {
  if (!fieldsOf(loc.hash).some(isCodeField)) return;
  replace(`${loc.pathname}${loc.search}`);
}

/** 등록 화면 진입: `?live=1`이거나 조각에 `code` 칸이 있으면 실제 연결 화면이고, 입력 칸 초깃값은 읽은 코드(없으면 빈 값)다 */
export function enrollScreenEntry(o: { live: boolean; hash: string }): { live: boolean; initialCode: string } {
  const hasCode = fieldsOf(o.hash).some(isCodeField);
  return { live: o.live || hasCode, initialCode: enrollmentCodeFromHash(o.hash) ?? "" };
}
