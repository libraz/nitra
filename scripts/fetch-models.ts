/**
 * Put the face-analysis runtime under `public/` so the app serves its own.
 *
 * The models are not committed: they are twenty megabytes of binary that would
 * be re-added to the history on every model revision. They are also not loaded
 * from anyone else's host at runtime. A photo never leaves the device, and a
 * request to a third party on page load would still tell that third party the
 * app is in use — which is the same promise viewed from the other end.
 *
 * Every artefact is pinned, by version in the URL and by digest here. A model
 * that changes under the same URL changes what the app renders, and that is not
 * something a build should absorb quietly.
 */

import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'models');

const BASE = 'https://storage.googleapis.com/mediapipe-models';

interface Artefact {
  name: string;
  url: string;
  sha256: string;
}

const MODELS: readonly Artefact[] = [
  {
    name: 'face_landmarker.task',
    url: `${BASE}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
    sha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
  },
  {
    name: 'selfie_multiclass_256x256.tflite',
    url: `${BASE}/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite`,
    sha256: 'c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0',
  },
];

/**
 * The runtime files the task loader asks for by name.
 *
 * Copied out of the installed package rather than downloaded, so the WASM and
 * the JavaScript that drives it can never be two different releases. The
 * `module_internal` pair that ships alongside these is for a loader this app
 * does not use, and leaving it out keeps eleven megabytes out of the deploy.
 *
 * Taking them from the dependency tree is also why `build` installs before it
 * runs this: the models come off the network and these do not, so a host that
 * hands a checkout straight to the build command would otherwise get as far as
 * a working model and no runtime to read it with.
 */
const RUNTIME = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
] as const;

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function alreadyThere(path: string, sha256: string): Promise<boolean> {
  try {
    return digest(await readFile(path)) === sha256;
  } catch {
    return false;
  }
}

async function fetchModel(artefact: Artefact): Promise<void> {
  const path = join(outDir, artefact.name);
  if (await alreadyThere(path, artefact.sha256)) {
    console.log(`  ${artefact.name} — already current`);
    return;
  }
  const response = await fetch(artefact.url);
  if (!response.ok) {
    throw new Error(`${artefact.name}: ${response.status} ${response.statusText}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = digest(bytes);
  if (actual !== artefact.sha256) {
    throw new Error(
      `${artefact.name}: expected sha256 ${artefact.sha256}, got ${actual}. ` +
        'The published model changed; check what it renders before updating the digest.',
    );
  }
  await writeFile(path, bytes);
  console.log(`  ${artefact.name} — ${(bytes.length / 1e6).toFixed(1)} MB`);
}

async function copyRuntime(): Promise<void> {
  const from = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
  const to = join(outDir, 'wasm');
  await mkdir(to, { recursive: true });
  for (const name of RUNTIME) {
    await cp(join(from, name), join(to, name));
  }
  console.log(`  wasm runtime — ${RUNTIME.length} files`);
}

await mkdir(outDir, { recursive: true });
console.log('face analysis assets:');
for (const artefact of MODELS) await fetchModel(artefact);
await copyRuntime();
