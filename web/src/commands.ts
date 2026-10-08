// 명령 레지스트리 (SDD 6.4, ARCH-05). 메뉴와 단축키는 모두 여기서 나온다.

export interface Command {
  id: string;
  title: string;
  /** 'Ctrl+Shift+T' 형식. 첫 번째가 메뉴에 표시된다. */
  keys?: string[];
  run: () => unknown;
  enabled?: () => boolean;
  checked?: () => boolean;
  /** v1.1 이후 기능. 키만 잡아 브라우저 기본 동작을 막고, 메뉴·단축키 목록에는 보이지 않는다. */
  reserved?: boolean;
}

const CODE_NAMES: Record<string, string> = {
  Equal: '=',
  Minus: '-',
  NumpadAdd: '=',
  NumpadSubtract: '-',
  Backquote: '`',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Escape: 'Esc',
  Tab: 'Tab',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Space: 'Space',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Home: 'Home',
  End: 'End',
  Delete: 'Delete',
  Backspace: 'Backspace',
};

/**
 * 키 이벤트를 'Ctrl+Alt+Shift+키' 문자열로 바꾼다.
 * 한글 입력기가 켜져 있어도 같은 키가 나오도록 e.key 대신 e.code(물리 키)를 쓴다.
 */
export function eventToKey(e: Pick<KeyboardEvent, 'code' | 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): string | null {
  let name: string | undefined;
  const code = e.code;
  if (/^Key[A-Z]$/.test(code)) name = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) name = code.slice(5);
  else if (/^Numpad[0-9]$/.test(code)) name = code.slice(6);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) name = code;
  else name = CODE_NAMES[code];
  if (!name) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(name);
  return parts.join('+');
}

export class CommandRegistry {
  private cmds = new Map<string, Command>();
  private keymap = new Map<string, string>();
  onError: (err: unknown) => void = (err) => console.error(err);

  register(cmd: Command) {
    this.cmds.set(cmd.id, cmd);
    for (const k of cmd.keys ?? []) this.keymap.set(k, cmd.id);
  }

  get(id: string): Command | undefined {
    return this.cmds.get(id);
  }

  all(): Command[] {
    return [...this.cmds.values()];
  }

  isEnabled(id: string): boolean {
    const c = this.cmds.get(id);
    return !!c && (c.enabled ? c.enabled() : true);
  }

  run(id: string): boolean {
    const c = this.cmds.get(id);
    if (!c || !this.isEnabled(id)) return false;
    try {
      const r = c.run();
      if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch(this.onError);
    } catch (err) {
      this.onError(err);
    }
    return true;
  }

  keyFor(id: string): string | undefined {
    return this.cmds.get(id)?.keys?.[0];
  }

  commandForKey(key: string): string | undefined {
    return this.keymap.get(key);
  }

  /** 등록된 단축키면 실행하고 true. 기본 동작(브라우저 인쇄·찾기 등)은 막는다. */
  handleKey(e: KeyboardEvent): boolean {
    const key = eventToKey(e);
    if (!key) return false;
    const id = this.keymap.get(key);
    if (!id) return false;
    e.preventDefault();
    e.stopPropagation();
    this.run(id);
    return true;
  }
}
