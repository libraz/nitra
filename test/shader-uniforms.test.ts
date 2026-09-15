/**
 * Every uniform a shader declares has to be set, and every uniform the render
 * layer sets has to exist.
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
import * as hair from '../src/core/render/shaders/hair';
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

/** Every program the pipeline builds, and the source of each. */
const PROGRAMS: Record<string, string> = {
  ingest: passes.INGEST_FRAGMENT,
  grade: passes.GRADE_FRAGMENT,
  blur: passes.BLUR_FRAGMENT,
  copy: passes.COPY_FRAGMENT,
  finish: passes.FINISH_FRAGMENT,
  subjectRaw: bokeh.SUBJECT_RAW_FRAGMENT,
  bokehLift: bokeh.BOKEH_LIFT_FRAGMENT,
  bokehGather: bokeh.BOKEH_GATHER_FRAGMENT,
  bokeh: bokeh.BOKEH_FRAGMENT,
  boxBlur: face.BOX_BLUR_FRAGMENT,
  warpField: face.FACE_WARP_FIELD_FRAGMENT,
  warp: face.FACE_WARP_FRAGMENT,
  faceMean: face.FACE_MEAN_FRAGMENT,
  faceLocal: face.FACE_LOCAL_FRAGMENT,
  faceDeviation: face.FACE_DEVIATION_FRAGMENT,
  faceCoeff: face.FACE_COEFF_FRAGMENT,
  faceMaskRaw: face.FACE_MASK_RAW_FRAGMENT,
  faceMaskDeviation: face.FACE_MASK_DEVIATION_FRAGMENT,
  faceMaskCoeff: face.FACE_MASK_COEFF_FRAGMENT,
  faceMaskApply: face.FACE_MASK_APPLY_FRAGMENT,
  skin: face.FACE_SKIN_FRAGMENT,
  parts: face.FACE_PARTS_FRAGMENT,
  hairRaw: hair.HAIR_RAW_FRAGMENT,
  hair: hair.HAIR_FRAGMENT,
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
  it('covers every program the pipeline builds', () => {
    // The list above is written by hand, so the thing to check is that it is
    // complete — and completeness has to be decided against the shader modules
    // rather than against the list itself. Intersecting the two and comparing
    // the result to the list is the mistake this replaced: it says every name
    // in the list is built, which is true of a list missing half the shaders.
    //
    // What makes it decidable is that the modules export nothing but shaders, so
    // a `Program.create` naming one of their exports is a program this file is
    // responsible for, and a new shader is unchecked until it is added.
    const shaders = new Set(
      [bokeh, face, hair, passes].flatMap((module) =>
        Object.keys(module).filter((name) => name.endsWith('_FRAGMENT')),
      ),
    );
    const built = [...pipelineSource.matchAll(/(\w+): Program\.create\(this\.gl, (\w+)\)/g)];
    const fromShaders = built
      .filter(([, , source]) => shaders.has(source as string))
      .map(([, key]) => key as string);
    expect(new Set(fromShaders)).toEqual(new Set(Object.keys(PROGRAMS)));
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

  it('names the photograph in the signature of every node that samples it', () => {
    // The photograph is not a constant: the Heal stage substitutes a plate with
    // the fills in it, and says so by moving the source's generation. A node
    // that samples the source without carrying that number in its signature
    // breaks the graph's one rule — equal signatures, equal pixels — and the
    // failure is a fill that is missing from one stage's cached result and
    // present in the rest, which is not a shape anybody would look for.
    const missing = graphSource
      .split(/\n {2}const /)
      // A node, rather than any declaration at that indentation: the helpers
      // beside them reach for the source texture too, as the stand-in bound to
      // a sampler a pass is told not to read, and a helper has no signature to
      // carry anything in.
      .filter((node) => /id: '[^']+'/.test(node))
      .filter((node) => node.includes('ctx.source.texture'))
      .filter((node) => !node.includes('ctx.source.generation'))
      .map((node) => node.match(/id: '([^']+)'/)?.[1] ?? node.slice(0, 40));
    expect(missing).toEqual([]);
  });
});

describe('the stage shaders themselves', () => {
  it('writes a result from every one of them', () => {
    for (const [program, source] of Object.entries(PROGRAMS)) {
      expect(source.includes('fragColor'), program).toBe(true);
    }
  });

  /** The stages that go from the rendered frame into the masks' own space. */
  const MASK_READERS = ['skin', 'parts', 'faceTexture', 'faceProbe'];

  /** The stages that read a mask covering the whole frame. */
  const FRAME_MASK_READERS = ['bokehLift', 'bokeh', 'hair'];

  it('reads a frame-wide mask through the framing and the displacement', () => {
    // These masks were built before the photo was cropped and before the face
    // was reshaped, so both have to be composed or the boundary sits a
    // displacement away from the shoulder it is meant to follow.
    for (const program of FRAME_MASK_READERS) {
      const source = PROGRAMS[program] as string;
      expect(source.includes('warped((uGeometry * vec3(vUv, 1.0)).xy)'), program).toBe(true);
    }
  });

  it('leaves the separation unconfined to a working area', () => {
    // What it divides is the picture, so there is no rectangle around the faces
    // to map into. The hair stage is the one that reads both: a frame-wide mask
    // for the hair and the working area for the skin it must not reach.
    for (const program of ['bokehLift', 'bokeh']) {
      expect((PROGRAMS[program] as string).includes('toRegion('), program).toBe(false);
    }
    expect(hair.HAIR_FRAGMENT).toMatch(/toRegion\(frame\)/);
  });

  it('keeps the hair off the face by the landmarks rather than by the model', () => {
    // Both halves, and each covers what the other cannot. The skin mask has the
    // features subtracted from it by construction, so on its own it leaves the
    // eyes and the lips open to a hair tint; the features on their own say
    // nothing about a cheek. Measured on a face six per cent of the frame, the
    // segmentation's own face-skin class moved the leak by almost nothing.
    expect(hair.HAIR_FRAGMENT).toMatch(
      /max\(texture\(uSkin, region\)\.r, texture\(uPoly, region\)\.g\)/,
    );
    expect(hair.HAIR_FRAGMENT).toMatch(/hair \*= 1\.0 - face/);
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

  it('asks two questions of a grey strand and one of a sheen', () => {
    // A strand that is only lighter than the hair around it is a highlight, and
    // desaturating a highlight is how hair comes out looking wet. The grey work
    // runs first for the other direction: a strand put back to the hair's own
    // colour is no longer a candidate for being brightened as a band of light.
    expect(hair.HAIR_FRAGMENT).toMatch(/float weight = lighter \* washed \* hair \* uGrey/);
    expect(hair.HAIR_FRAGMENT.indexOf('uGrey >')).toBeLessThan(
      hair.HAIR_FRAGMENT.indexOf('uSheen >'),
    );
  });

  it('measures the hair against a local average rather than a threshold', () => {
    // Hair is the darkest large thing in most portraits and the brightest in
    // some. An absolute lightness would find the highlight on dark hair and the
    // whole head on light hair.
    for (const expression of ['L - mean.x', 'length(mean.yz)']) {
      expect(hair.HAIR_FRAGMENT.includes(expression), expression).toBe(true);
    }
  });

  it('narrows the iris to where the circle and the opening agree', () => {
    // Either channel alone is the wrong region. The fitted circle reaches under
    // the eyelid, so on its own the work lands on skin; the opening contains the
    // white of the eye, so on its own it puts iris contrast on the sclera.
    expect(face.FACE_PARTS_FRAGMENT).toMatch(/float iris = polyB\.a \* polyB\.r/);
  });

  it('expands the iris about a local average rather than a fixed pivot', () => {
    // A pivot would darken a pale eye and lighten a dark one, which is a change
    // of eye colour wearing a contrast slider's label.
    expect(face.FACE_PARTS_FRAGMENT).toMatch(
      /float detail = L - perSkin\(texture\(uMean, region\)\)\.x/,
    );
  });

  it('gives the parts stage the plain window and the skin stage the weighted one', () => {
    // Both are called `uMean` where they are read, so which texture is bound is
    // the whole of the distinction, and it is made in one line of the graph. An
    // iris averaged over the skin around it is averaged over the eyelid, since
    // the features are what the skin mask has taken out: the expansion then
    // pushes the eye towards the colour of the lid, which is not a contrast
    // control at all.
    expect(graphSource).toMatch(/id: 'parts',\n\s*inputs: \['skin', 'faceLocalV'/);
    expect(graphSource).toMatch(/id: 'skin',\n\s*inputs: \['warp', 'faceCoeff', 'faceMeanV'/);
  });

  it('divides every weighted average through before reading it', () => {
    // The statistics carry the skin they averaged over in the fourth channel, so
    // a reader that takes `.xyz` straight gets a lightness scaled by how much
    // skin happened to be in the window — near one over a cheek, near zero at
    // the jaw. Which reads as a stage that works in the middle of a face and
    // fades out towards the edge of it, rather than as an arithmetic mistake.
    // Named rather than found by the sampler's name, because the same name is
    // used for a different texture: the mask's own refinement has a `uMean`
    // holding two unweighted signals, and it is not this. Which is the whole
    // reason to write the pairs out — there is no property of the source that
    // tells the two apart, so a guess at one is a check that passes for the
    // wrong reason.
    const READERS: Record<string, string[]> = {
      faceDeviation: ['uMean'],
      faceCoeff: ['uMean', 'uVariance'],
      skin: ['uCoeff', 'uMean', 'uWideMean'],
      parts: ['uMean', 'uWideMean'],
      faceProbe: ['uMean', 'uWideMean'],
    };

    for (const [name, samplers] of Object.entries(READERS)) {
      const source = PROGRAMS[name] as string;
      expect(source, `${name} does not have the helper`).toContain('perSkin');
      for (const sampler of samplers) {
        expect(source, `${name} does not declare ${sampler}`).toContain(
          `uniform sampler2D ${sampler};`,
        );
        // Stated as what may not appear rather than as what must: the division
        // can be taken at the read or later, off a variable holding the whole of
        // it, and both are fine. What is never fine is a channel taken straight
        // off the packed texture, and that is the one a reader writes by habit,
        // because it is what these textures held before they carried a weight.
        const swizzled = new RegExp(`texture\\(${sampler},[^)]*\\)\\.[xyzwrgba]`);
        expect(swizzled.test(source), `${name} takes a channel of ${sampler} undivided`).toBe(
          false,
        );
      }
    }
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
