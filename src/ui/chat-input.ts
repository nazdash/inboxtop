import { TextareaRenderable } from '@opentui/core';

// Keep the existing Chat draft limit while allowing wrapped and pasted lines.
export class ChatInput extends TextareaRenderable {
  override insertText(text: string) {
    const remaining = 2000 - this.plainText.length + this.getSelectedText().length;
    let addition = text.replace(/\r\n?/g, '\n').slice(0, Math.max(0, remaining));
    // Do not split a surrogate pair at the draft boundary.
    if (/[\uD800-\uDBFF]$/.test(addition)) addition = addition.slice(0, -1);
    if (addition) super.insertText(addition);
  }

  override newLine() {
    this.insertText('\n');
    return true;
  }
}
