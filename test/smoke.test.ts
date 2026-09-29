import { expect, test } from 'vitest';

test('shared types module resolves', async () => {
  await expect(import('../src/types.ts')).resolves.toBeDefined();
});
