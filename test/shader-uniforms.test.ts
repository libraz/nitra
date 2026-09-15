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
import { MAX_CONTROL_POINTS } from '../src/core/face/warp';
import * as bokeh from '../src/core/render/shaders/bokeh';
import { GLSL_COLOR } from '../src/core/render/shaders/common';
import * as face from '../src/core/render/shaders/face';
import * as passes from '../src/core/render/shaders/passes';

const pipelineSource = readFileSync(
  new URL('../src/core/render/pipeline.ts', import.meta.url),
  'utf8',
);

const graphSource = readFileSync(new URL('../src/core/render/graph.ts', import.meta.url), 'utf8');

const uniformsSource = readFileSync(
  new URL('../src/core/render/uniforms.ts', import.meta.url),
  'utf8',
);

/** The programs built from a stage shader, and the source of each. */
const PROGRAMS: Record<string, string> = {
  subjectRaw: bokeh.SUBJECT_RAW_FRAGMENT,
  bokehLift: bokeh.BOKEH_LIFT_FRAGMENT,
  bokehGather: bokeh.BOKEH_GATHER_FRAGMENT,
  bokeh: bokeh.BOKEH_FRAGMENT,
  boxBlur: face.BOX_BLUR_FRAGMENT,
  warpField: face.FACE_WARP_FIELD_FRAGMENT,
  warp: face.FACE_WARP_FRAGMENT,
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
 * Everywhere a uniform is set, with the comments taken out.
 *
 * Both files that set one: the graph binds the stages, while the pipeline class
 * binds the mask refinement, the box blur and the probes. Read from only one of
 * them, every uniform belonging to the other would be reported as never set.
 *
 * Attribution below splits on the statement separator, and a semicolon inside a
 * comment splits a setter chain in half — which would drop the uniforms after it
 * from the program they belong to and report them as never set. Worse in the
 * other direction: a real missing uniform in the first half would be excused by
 * a stray semicolon in the prose above it.
 */
const renderCode = `${pipelineSource}\n${graphSource}`
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/**
 * The uniform names set on one program, read out of the render layer.
 *
 * The setters are chained off `programs.<name>.bind()`, so one statement is one
 * program's worth of calls, and splitting on the statement separator is enough
 * to attribute them without parsing TypeScript.
 *
 * The name has to end where it is written, or one program's name is a prefix of
 * another's and it collects the other's uniforms — `warp` would be credited with
 * everything `warpField` sets, and then neither of them is really being checked.
 */
function assignedUniforms(program: string): Set<string> {
  const names = new Set<string>();
  const call = new RegExp(`programs\\.${program}\\b`);
  for (const statement of renderCode.split(';')) {
    if (!call.test(statement)) continue;
    for (const [, name] of statement.matchAll(/'(u[A-Z]\w*)'/g)) {
      if (name) names.add(name);
    }
  }
  return names;
}

describe('the stage shaders and the calls that drive them', () => {
  it('covers every program the pipeline builds from a stage shader', () => {
    // A new shader that nothing here knows about would go unchecked.
    const built = [
      ...pipelineSource.matchAll(/(\w+): Program\.create\(this\.gl, (\w+)_FRAGMENT\)/g),
    ].map(([, key]) => key as string);
    const fromStageShaders = built.filter((key) => key in PROGRAMS);
    expect(new Set(fromStageShaders)).toEqual(new Set(Object.keys(PROGRAMS)));
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

describe('the stage shaders themselves', () => {
  it('writes a result from every one of them', () => {
    for (const [program, source] of Object.entries(PROGRAMS)) {
      expect(source.includes('fragColor'), program).toBe(true);
    }
  });

  /** The stages that go from the rendered frame into the masks' own space. */
  const MASK_READERS = ['skin', 'parts', 'faceTexture', 'faceProbe'];

  /** The stages whose mask is the whole frame rather than a working area. */
  const FRAME_MASK_READERS = ['bokehLift', 'bokeh'];

  it('reads the separation through the framing and the displacement', () => {
    // The separation covers the frame, so there is no working area to map into
    // and no `toRegion` — but it was still built before the photo was cropped
    // and before the face was reshaped, so both of those still have to be
    // composed or the boundary sits a displacement away from the shoulder.
    for (const program of FRAME_MASK_READERS) {
      const source = PROGRAMS[program] as string;
      expect(source.includes('warped((uGeometry * vec3(vUv, 1.0)).xy)'), program).toBe(true);
      expect(source.includes('toRegion('), program).toBe(false);
    }
  });

  it('samples the masks through the framing matrix', () => {
    // The masks are built in the source image's own frame. A stage that sampled
    // them with its own coordinates would put the mask somewhere else the moment
    // the photo was cropped or rotated.
    for (const program of MASK_READERS) {
      const source = PROGRAMS[program] as string;
      expect(source.includes('uGeometry * vec3(vUv, 1.0)'), program).toBe(true);
    }
  });

  it('samples the masks through the displacement as well', () => {
    // And then through the reshaping, in that order. The masks know nothing
    // about a displacement, so a stage that stopped at the matrix would read the
    // mask where the pixel is rather than where its content came from — the
    // smoothing would run off the jaw on one side and stop short on the other.
    for (const program of MASK_READERS) {
      const source = PROGRAMS[program] as string;
      expect(source.includes('toRegion(warped((uGeometry * vec3(vUv, 1.0)).xy))'), program).toBe(
        true,
      );
    }
  });

  it('leaves the reshaping out of the pass the photograph arrives through', () => {
    // `ingest` is what the photo looked like before anything was done to it,
    // which is what the before-and-after view shows. A displacement in there
    // would redefine "before" as "before everything except the reshaping".
    expect(passes.INGEST_FRAGMENT.includes('warped(')).toBe(false);
    expect(face.FACE_WARP_FRAGMENT.includes('warped(')).toBe(true);
  });

  it('fades the displacement out as well as averaging it', () => {
    // An average on its own has no falloff. With one control point the weight
    // cancels between the numerator and the denominator, so the displacement is
    // the full delta everywhere inside the support and zero immediately outside
    // it — a step, which is a tear in the picture rather than a reshaping.
    // Measured on a GPU; asserted here because this suite has none, and the
    // expression reads like something worth simplifying back.
    expect(face.FACE_WARP_FIELD_FRAGMENT).toMatch(/\(sum \/ weight\) \* peak/);
  });

  it('bounds the control points by the same number the allocation uses', () => {
    // A point past the array's length would not be summed, and the part of the
    // face it described would stay put while its neighbours moved.
    expect(face.FACE_WARP_FIELD_FRAGMENT).toContain(`uniform vec4 uPoint[${MAX_CONTROL_POINTS}]`);
    expect(face.FACE_WARP_FIELD_FRAGMENT).toContain(`i < ${MAX_CONTROL_POINTS}`);
  });

  it('convolves the background in linear light', () => {
    // The reason the working space is linear at all. In a gamma space a bright
    // point smears into a dull cloud instead of spreading as a disc that holds
    // its energy, and that one difference is most of what separates a defocused
    // background from a blurred one. A transfer function anywhere in this chain
    // would undo it silently: the result still looks blurred.
    //
    // The shared colour block is taken out first, because it is where both
    // transfer functions are declared — searching the whole source finds the
    // declaration in every shader that includes it and proves nothing.
    for (const program of ['bokehLift', 'bokehGather', 'bokeh']) {
      const body = (PROGRAMS[program] as string).replace(GLSL_COLOR, '');
      expect(body.includes('encodeTransfer('), program).toBe(false);
      expect(body.includes('decodeTransfer('), program).toBe(false);
    }
  });

  it('weights the background by its own coverage and divides by what it found', () => {
    // The halo fix, and it is two halves that only work together. The lift
    // multiplies by the background weight and carries it alongside; the gather
    // divides by the weight it accumulated rather than by the tap count. Keep
    // only the first and the background darkens towards every subject edge;
    // keep only the second and the subject's own colour is dragged outwards as
    // a rim of light, which is the artefact that gives the whole effect away.
    expect(bokeh.BOKEH_LIFT_FRAGMENT).toMatch(/colour \* lift \* background, background\)/);
    expect(bokeh.BOKEH_GATHER_FRAGMENT).toMatch(/total\.rgb \/ max\(total\.a/);
  });

  it('bounds the gather by a constant and spends every tap on the aperture', () => {
    // A loop bound by a uniform does not compile everywhere. Shaping the unit
    // disc rather than discarding the taps that fall outside the shape is what
    // keeps a hexagon's middle as well sampled as a circle's.
    expect(bokeh.BOKEH_GATHER_FRAGMENT).toMatch(/for \(int i = 0; i < BOKEH_TAPS; i\+\+\)/);
    expect(bokeh.BOKEH_GATHER_FRAGMENT).toMatch(/unit \*= hexReach\(angle\)/);
  });

  it('puts the defocus before the grade', () => {
    // Stage order is a statement about the picture. A lens is in front of the
    // film, so raising the exposure and then defocusing is not a photograph
    // anything could have taken — and the difference shows in the highlights,
    // which is the one place the effect is judged.
    expect(graphSource).toMatch(/id: 'grade',\s*inputs: \['bokeh'\]/);
  });

  it('keeps the loop in the blur bounded by a constant', () => {
    // A loop bound by a uniform does not compile everywhere, so the radius is
    // clamped against the same constant the shader is written with.
    expect(face.BOX_BLUR_FRAGMENT).toMatch(/for \(int i = -64; i <= 64; i\+\+\)/);
    expect(uniformsSource).toMatch(/MAX_BLUR_RADIUS = 64/);
  });
});
