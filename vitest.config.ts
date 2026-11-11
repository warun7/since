import { configDefaults, defineConfig } from 'vitest/config';

// A git worktree under .claude/ (an agent's copy of the repo) would otherwise run every test twice.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, '.claude/**', '.demo/**'] },
});
