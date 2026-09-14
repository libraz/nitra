/**
 * Every uniform a face shader declares has to be set, and every uniform the
 * pipeline sets has to exist.
 *
 * This is checked because WebGL will not check it. Asking for the location of a
 * uniform that is not there returns nothing and setting it is quietly ignored,
 * so a mistyped name is not an error — it is a slider that moves and changes
 * nothing, which reads as a broken control rather than as a typo. In the other
 * direction a declared-but-never-set uniform is a stage running on zero.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as face from '../src/core/render/shaders/face';

const pipelineSource = readFileSync(
  new URL('../src/core/render/pipeline.ts', import.meta.url),
  'utf8',
);

/** The programs built from the face shaders, and the source of each. */
const PROGRAMS: Record<string, string> = {
  boxBlur: face.BOX_BLUR_FRAGMENT,
  faceMean: face.FACE_MEAN_FRAGMENT,
  faceDeviation: face.FACE_DEVIATION_FRAGMENT,
  faceCoeff: face.FACE_COEFF_FRAGMENT,
  faceMaskRaw: face.FACE_MASK_RAW_FRAGMENT,
  faceMaskDeviation: face.FACE_MASK_DEVIATION_FRAGMENT,
  faceMaskCoeff: face.FACE_MASK_COEFF_FRAGMENT,
  faceMaskApply: face.FACE_MASK_APPLY_FRAGMENT,
  skin: face.FACE_SKIN_FRAGMENT,
  parts: face.FACE_PARTS_FRAGMENT,
  faceTexture: face.FACE_TEXTURE_FRAGMENT,
  faceProbe: face.FACE_PROBE_FRAGMENT,
};

function declaredUniforms(source: string): Set<string> {
  const names = new Set<string>();
  for (const line of source.split('\n')) {
    const match = line.match(/^\s*uniform\s+\w+\s+(\w+)\s*(\[[^\]]*\])?\s*;/);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

/**
 * The uniform names set on one program, read out of the pipeline.
 *
 * The setters are chained off `programs.<name>.bind()`, so one statement is one
 * program's worth of calls, and splitting on the statement separator is enough
 * to attribute them without parsing TypeScript.
 */
function assignedUniforms(program: string): Set<string> {
  const names = new Set<string>();
  for (const statement of pipelineSource.split(';')) {
    if (!statement.includes(`programs.${program}`)) continue;
    for (const [, name] of statement.matchAll(/'(u[A-Z]\w*)'/g)) {
      if (name) names.add(name);
    }
  }
  return names;
}

describe('the face shaders and the calls that drive them', () => {
  it('covers every program the pipeline builds from a face shader', () => {
    // A new shader that nothing here knows about would go unchecked.
    const built = [
      ...pipelineSource.matchAll(/(\w+): Program\.create\(this\.gl, (\w+)_FRAGMENT\)/g),
    ].map(([, key]) => key as string);
    const fromFaceShaders = built.filter((key) => key in PROGRAMS);
    expect(new Set(fromFaceShaders)).toEqual(new Set(Object.keys(PROGRAMS)));
  });

  for (const [program, source] of Object.entries(PROGRAMS)) {
    it(`sets every uniform ${program} declares`, () => {
      const declared = declaredUniforms(source);
      const assigned = assignedUniforms(program);
      expect(declared.size, `${program} declares no uniforms`).toBeGreaterThan(0);
      for (const name of declared) {
        expect(assigned.has(name), `${program} never sets ${name}`).toBe(true);
      }
    });

    it(`sets nothing ${program} does not declare`, () => {
      const declared = declaredUniforms(source);
      for (const name of assignedUniforms(program)) {
        expect(declared.has(name), `${program} sets ${name}, which it does not declare`).toBe(true);
      }
    });
  }
});

describe('the face shaders themselves', () => {
  it('writes a result from every one of them', () => {
    for (const [program, source] of Object.entries(PROGRAMS)) {
      expect(source.includes('fragColor'), program).toBe(true);
    }
  });

  it('samples the masks through the framing matrix', () => {
    // The masks are built in the source image's own frame. A stage that sampled
    // them with its own coordinates would put the mask somewhere else the moment
    // the photo was cropped or rotated.
    for (const program of ['skin', 'parts', 'faceTexture', 'faceProbe']) {
      const source = PROGRAMS[program] as string;
      expect(source.includes('uGeometry * vec3(vUv, 1.0)'), program).toBe(true);
    }
  });

  it('keeps the loop in the blur bounded by a constant', () => {
    // A loop bound by a uniform does not compile everywhere, so the radius is
    // clamped against the same constant the shader is written with.
    expect(face.BOX_BLUR_FRAGMENT).toMatch(/for \(int i = -64; i <= 64; i\+\+\)/);
    expect(pipelineSource).toMatch(/MAX_BLUR_RADIUS = 64/);
  });
});
