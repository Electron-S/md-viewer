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
