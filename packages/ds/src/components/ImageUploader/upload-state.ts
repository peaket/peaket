// ImageUploader의 업로드 상태 전이(구현 리뷰 IR-05). 화면 없이 시험할 수 있게 순수 함수로 둔다.
// - 올리기 시작: 파일을 서버로 보내는 동안 '확인하는 중'(scanning)을 보인다. 서버가 검사까지 마치면 ready가 된다.
// - 실패: error와 retryable을 남기고, [다시 시도]는 항목이 들고 있는 원본 File로 upload를 다시 부른다.
export type UploadStatus = 'ready' | 'uploading' | 'scanning' | 'error';

export interface UploadStateItem {
  id: string;
  status: UploadStatus;
  imageId?: string;
  progress?: number;
  caption?: string;
  error?: string;
  retryable?: boolean;
  previewUrl?: string;
  /** [다시 시도]가 다시 올릴 원본 파일(브라우저 메모리에만 둔다) */
  file?: File;
}

export function beginUpload<T extends UploadStateItem>(items: readonly T[], id: string): T[] {
  return items.map((item) => (item.id === id ? ({ ...item, status: 'scanning', progress: undefined, error: undefined, retryable: undefined } as T) : item));
}

export function finishUpload<T extends UploadStateItem>(items: readonly T[], id: string, imageId: string): T[] {
  return items.map((item) => (item.id === id ? ({ ...item, status: 'ready', imageId, progress: 100, error: undefined, retryable: undefined } as T) : item));
}

export function failUpload<T extends UploadStateItem>(items: readonly T[], id: string, message: string, retryable: boolean): T[] {
  return items.map((item) => (item.id === id ? ({ ...item, status: 'error', progress: undefined, error: message, retryable } as T) : item));
}

export function retryFile<T extends UploadStateItem>(items: readonly T[], id: string): File | undefined {
  return items.find((item) => item.id === id)?.file;
}
