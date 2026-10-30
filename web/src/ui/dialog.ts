import { S } from '../strings';

export interface DialogButton {
  label: string;
  value: string;
  primary?: boolean;
}

/** 모달 대화상자. 닫힌 버튼의 value를 돌려준다 (Esc는 undefined). */
export function showDialog(title: string, body: Node | string, buttons: DialogButton[] = [{ label: S.dialog.ok, value: 'ok', primary: true }]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'mdv-dialog';
    const h = document.createElement('h2');
    h.textContent = title;
    const content = document.createElement('div');
    content.className = 'dialog-body';
    if (typeof body === 'string') content.textContent = body;
    else content.append(body);
    const row = document.createElement('div');
    row.className = 'dialog-buttons';
    let result: string | undefined;
    for (const b of buttons) {
      const el = document.createElement('button');
      el.textContent = b.label;
      if (b.primary) el.className = 'primary';
      el.addEventListener('click', () => {
        result = b.value;
        dlg.close();
      });
      row.append(el);
    }
    dlg.append(h, content, row);
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(result);
    });
    document.body.append(dlg);
    dlg.showModal();
    (row.querySelector('.primary') as HTMLElement | null)?.focus();
  });
}

/** 글 한 줄을 묻는다(실행기 모드의 저장 경로, FR-EDIT-05). Enter는 확인, Esc·취소는 undefined. */
export function promptText(title: string, label: string, value: string, hint?: string): Promise<string | undefined> {
  const box = document.createElement('div');
  const lab = document.createElement('label');
  lab.className = 'dialog-field';
  lab.textContent = label;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.spellcheck = false;
  lab.append(input);
  box.append(lab);
  if (hint) box.append(Object.assign(document.createElement('p'), { className: 'dialog-hint', textContent: hint }));
  const done = showDialog(title, box, [
    { label: S.dialog.ok, value: 'ok', primary: true },
    { label: S.dialog.cancel, value: 'cancel' },
  ]).then((v) => (v === 'ok' ? input.value : undefined));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      (input.closest('dialog')?.querySelector('.dialog-buttons .primary') as HTMLElement | null)?.click();
    }
  });
  // 이름 부분(확장자 앞)을 골라 둔다.
  requestAnimationFrame(() => {
    input.focus();
    const dot = value.lastIndexOf('.');
    const slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
    input.setSelectionRange(slash + 1, dot > slash ? dot : value.length);
  });
  return done;
}

let toastBox: HTMLElement | null = null;

export function toast(message: string, kind: 'info' | 'error' = 'info', ms = 4000) {
  if (!toastBox) {
    toastBox = document.createElement('div');
    toastBox.className = 'toast-box';
    toastBox.setAttribute('aria-live', 'polite');
    document.body.append(toastBox);
  }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = message;
  toastBox.append(t);
  setTimeout(() => t.remove(), ms);
}
