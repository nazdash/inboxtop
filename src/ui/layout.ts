export const MIN_TERMINAL_WIDTH = 40;
export const MIN_TERMINAL_HEIGHT = 18;

// Shared row budgets for overview pages. See UI-PRINCIPLES.md.
export function layoutFor(width: number, height: number, busy = false) {
  return {
    narrow: width < 65,
    splitPreview: width >= MIN_TERMINAL_WIDTH && height >= MIN_TERMINAL_HEIGHT,
    contentWidth: Math.max(1, width - 2),
    compact: height < 24,
    sectionGap: width >= 65 && height >= 30 ? 1 : 0,
    summaryRows:
      width < 65
        ? busy
          ? 1
          : height < 24
            ? 2
            : 4
        : height < 24
          ? busy
            ? 1
            : 3
          : height < 30
            ? busy
              ? 4
              : 6
            : 6,
    showDescriptions: width >= 65 && height >= (busy ? 44 : 40),
  };
}
