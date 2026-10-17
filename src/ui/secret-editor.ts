import type { KeyEvent } from '@opentui/core';

/** Keep plaintext outside renderable buffers, selection, clipboard and terminal output. */
export class SecretEditor {
  private chars: string[];
  cursor: number;
  constructor(value = '') {
    this.chars = Array.from(value);
    this.cursor = this.chars.length;
  }
  get value() {
    return this.chars.join('');
  }
  get masked() {
    return '•'.repeat(this.chars.length);
  }
  insert(value: string) {
    const chars = Array.from(value.replace(/[\x00-\x1f\x7f]/g, ''));
    const allowed = chars.slice(0, Math.max(0, 8192 - this.chars.length));
    this.chars.splice(this.cursor, 0, ...allowed);
    this.cursor += allowed.length;
  }
  key(key: KeyEvent) {
    if (key.ctrl) {
      if (key.name === 'u') {
        this.chars.splice(0, this.cursor);
        this.cursor = 0;
      } else if (key.name === 'a') this.cursor = 0;
      else if (key.name === 'e') this.cursor = this.chars.length;
      else if (key.name === 'w') {
        while (this.cursor && this.chars[this.cursor - 1] === ' ')
          this.chars.splice(--this.cursor, 1);
        while (this.cursor && this.chars[this.cursor - 1] !== ' ')
          this.chars.splice(--this.cursor, 1);
      }
      return;
    }
    if (key.meta || key.super || key.option) return;
    if (key.name === 'left') this.cursor = Math.max(0, this.cursor - 1);
    else if (key.name === 'right') this.cursor = Math.min(this.chars.length, this.cursor + 1);
    else if (key.name === 'home') this.cursor = 0;
    else if (key.name === 'end') this.cursor = this.chars.length;
    else if (key.name === 'backspace') {
      if (this.cursor) this.chars.splice(--this.cursor, 1);
    } else if (key.name === 'delete') this.chars.splice(this.cursor, 1);
    else if (key.sequence && !/[\x00-\x1f\x7f]/.test(key.sequence)) this.insert(key.sequence);
  }
  clear() {
    this.chars.fill('');
    this.chars = [];
    this.cursor = 0;
  }
}
