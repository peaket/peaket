// 위저드 임시저장의 브라우저 저장소(ADR-0245 결정 1). 공연 정보만 들어가고 개인정보는 없다. 저장소를 못 쓰는 브라우저에서는 false를 돌려준다.
import type { DraftStore } from '../../model/draft-keeper';
import { parseDraft, type WizardDraft } from '../../model/form';

const DRAFT_KEY = 'peaket.partner.wizard-draft.v1';
const REQUEST_KEY = 'peaket.partner.wizard-request.v1';

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export const browserDraftStore: DraftStore = {
  readDraft: () => read(DRAFT_KEY),
  writeDraft: (v) => write(DRAFT_KEY, v),
  readKey: () => read(REQUEST_KEY),
  writeKey: (v) => write(REQUEST_KEY, v),
  clear: () => {
    try {
      window.localStorage.removeItem(DRAFT_KEY);
      window.localStorage.removeItem(REQUEST_KEY);
    } catch {
      // 저장소를 못 쓰면 지울 것도 없다
    }
  },
};

/** 다른 탭이 초안을 바꾸거나 지우면 알린다(지웠으면 null). 돌려준 함수로 그만 듣는다 */
export function watchOtherTabs(on: (draft: WizardDraft | null) => void): () => void {
  const handler = (e: StorageEvent) => {
    if (e.key === DRAFT_KEY) on(parseDraft(e.newValue));
    else if (e.key === null) on(null);
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}
