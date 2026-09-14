/**
 * libheif-js ships a hand-written `.d.ts` for its Emscripten module but not for
 * the pre-bundled browser entry point, which is the one nitra loads.
 */
declare module 'libheif-js/wasm-bundle' {
  interface HeifTarget {
    data: Uint8ClampedArray;
    width: number;
    height: number;
  }

  export interface HeifImage {
    get_width(): number;
    get_height(): number;
    display(target: HeifTarget, done: (result: HeifTarget | null) => void): void;
  }

  export class HeifDecoder {
    decode(bytes: Uint8Array): HeifImage[];
  }

  const libheif: { HeifDecoder: typeof HeifDecoder };
  export default libheif;
}
