// 유스케이스 층: 받는 층이 multipart 본문에서 읽어 넘기는 칸(ADR-0257 결정 2·8). 파일 이름은 확장자를 보는 데만 쓰고 버린다.
import { RequestValidationError } from '@peaket/platform';

export interface UploadedFile {
  /** multipart 칸 이름 */
  field: string;
  /** 보낸 파일 이름(저장하지 않는다) */
  name: string;
  /** 파일 칸의 Content-Type */
  type: string;
  size: number;
  bytes(): Promise<Uint8Array>;
}

export interface UploadForm {
  files: UploadedFile[];
  fields: { name: string; value: string }[];
}

/** 정한 칸만 있는가: 파일 칸 하나(file)와 글자 칸(이름마다 많아야 하나). 모르는 칸·겹친 칸은 400 */
export function strictFields(form: UploadForm, required: readonly string[], optional: readonly string[]): { file: UploadedFile; values: Map<string, string> } {
  if (form.files.length !== 1 || form.files[0]!.field !== 'file') throw new RequestValidationError('파일 칸은 file 하나다');
  const values = new Map<string, string>();
  for (const f of form.fields) {
    if (!required.includes(f.name) && !optional.includes(f.name)) throw new RequestValidationError('모르는 칸');
    if (values.has(f.name)) throw new RequestValidationError('겹친 칸');
    values.set(f.name, f.value);
  }
  for (const r of required) if (!values.has(r)) throw new RequestValidationError(`${r} 칸이 없다`);
  return { file: form.files[0]!, values };
}
