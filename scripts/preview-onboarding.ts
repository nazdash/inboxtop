import { createTestRenderer } from '@opentui/core/testing';
import { mkdir, writeFile } from 'node:fs/promises';
import { OnboardingScreen } from '../src/ui/onboarding.ts';
import { configFromValues } from '../src/config.ts';
await mkdir('docs/internal/previews', { recursive: true });
for (const [width, height] of [
  [80, 24],
  [40, 18],
]) {
  const t = await createTestRenderer({ width, height });
  const screen = new OnboardingScreen(
    t.renderer,
    configFromValues({
      EMAIL_ADDRESS: 'reader@example.invalid',
      IMAP_SERVER: 'imap.example.invalid',
    }),
    '/unused',
    {
      mail: async () => {},
      ai: async () => {},
      save: async (c) => c,
    },
  );
  try {
    for (const page of ['welcome', 'email', 'ai', 'save'] as const) {
      (screen as any).page = page;
      (screen as any).render();
      await t.flush();
      await writeFile(`docs/internal/previews/onboarding-${page}-${width}.txt`, t.captureCharFrame());
    }
  } finally {
    screen.dispose();
    await t.dispose();
  }
}
