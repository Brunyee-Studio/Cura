/**
 * The environment for a test's own git repos. Git hooks and `git rebase --exec` export GIT_DIR, GIT_INDEX_FILE and
 * the like; inherited, they point the test's git commands at the repository running the tests. The user's
 * global and system config (hooks, signing, diff settings) are kept out of the run too.
 */
export function gitTestEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...extra };
}
