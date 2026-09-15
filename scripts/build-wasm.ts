/**
 * Compile the inpainting crate and put it under `public/` beside the models.
 *
 * Built rather than committed, for the reason the models are fetched rather than
 * committed: a binary that is regenerated from source in the repository would be
 * re-added to the history on every change to that source, and the two could
 * silently disagree about which version is deployed.
 *
 * It needs a Rust toolchain with the `wasm32-unknown-unknown` target, which is
 * the one thing a checkout does not bring with it — so a missing target is
 * reported as what it is, with the command that installs it, rather than as a
 * linker error from inside cargo.
 */

import { spawnSync } from 'node:child_process';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const crate = join(root, 'crates', 'heal');
const outDir = join(root, 'public', 'wasm');

const TARGET = 'wasm32-unknown-unknown';

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.error) {
    throw new Error(
      `${command} is not on PATH. The inpainting module is compiled from ` +
        `crates/heal, which needs a Rust toolchain: https://rustup.rs`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

const installed = run('rustup', ['target', 'list', '--installed'], root);
if (!installed.includes(TARGET)) {
  throw new Error(`the ${TARGET} target is missing. Install it: rustup target add ${TARGET}`);
}

run('cargo', ['build', '--release', '--target', TARGET], crate);

await mkdir(outDir, { recursive: true });
const built = join(crate, 'target', TARGET, 'release', 'heal.wasm');
await cp(built, join(outDir, 'heal.wasm'));
console.log('inpainting module: heal.wasm');
