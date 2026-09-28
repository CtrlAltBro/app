import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// Build stamp baked into the renderer, so a running app says exactly which build it
// is (branch + commit, ✱ if the tree had uncommitted changes). Handy in dev to be
// sure everyone is talking about the same build on the VM. Git may be absent when
// building from a tarball, so every lookup falls back gracefully.
function git(args: string[], fallback = ''): string {
  try {
    return execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return fallback;
  }
}

const version: string = JSON.parse(readFileSync('package.json', 'utf8')).version;
const build = {
  version,
  branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], 'unknown'),
  commit: git(['rev-parse', '--short', 'HEAD'], 'nogit'),
  dirty: git(['status', '--porcelain']).length > 0,
  time: new Date().toISOString(),
};

// https://vitejs.dev/config
export default defineConfig({
  define: {
    __BUILD__: JSON.stringify(build),
  },
});
