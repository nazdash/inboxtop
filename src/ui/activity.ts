import type { TextRenderable } from '@opentui/core';

export type Activity = {
  node: TextRenderable;
  key: string;
  label: string;
  elapsed?: boolean;
};

/** A single visible operation. Ticks touch text only, never the screen or its focus. */
export class ActivityIndicator {
  private active?: Activity;
  private timer?: ReturnType<typeof setInterval>;
  private started = 0;
  private frame = 0;
  private painted = '';

  constructor(private now = () => performance.now()) {}

  bind(activity?: Activity) {
    const previous = this.active;
    if (
      previous &&
      previous.node !== activity?.node &&
      !previous.node.isDestroyed &&
      previous.node.chunks.map((chunk) => chunk.text).join('') === this.painted
    )
      previous.node.content = previous.label;
    if (!activity) {
      this.dispose();
      return;
    }
    if (previous?.key !== activity.key) {
      this.started = this.now();
      this.frame = 0;
    }
    this.active = activity;
    this.paint();
    if (this.active && !this.timer) {
      this.timer = setInterval(() => {
        this.frame++;
        this.paint();
      }, 180);
      this.timer.unref?.();
    }
  }

  private paint() {
    const activity = this.active;
    if (!activity) return;
    if (activity.node.isDestroyed || !activity.node.visible) {
      this.dispose();
      return;
    }
    const label = `${['|', '/', '-', '\\'][this.frame % 4]} ${activity.label}`;
    const seconds = Math.floor((this.now() - this.started) / 1000);
    const elapsed = ` · ${seconds}s`;
    // Width is known after layout. Never make elapsed time add a wrapped row.
    this.painted =
      activity.elapsed !== false &&
      seconds >= 3 &&
      Bun.stringWidth(label + elapsed) <= activity.node.width
        ? label + elapsed
        : label;
    activity.node.content = this.painted;
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (
      this.active &&
      !this.active.node.isDestroyed &&
      this.active.node.chunks.map((chunk) => chunk.text).join('') === this.painted
    )
      this.active.node.content = this.active.label;
    this.active = undefined;
  }
}
