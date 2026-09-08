import type { Compressors } from "hyparquet";
import { compressors as defaultCompressors } from "hyparquet-compressors";
import { ZSTDDecoder } from "zstddec";

let compressorPromise: Promise<Compressors> | undefined;

/** Initializes the shared WASM decoder once and hides codec setup from readers. */
export function loadCompressors(): Promise<Compressors> {
  compressorPromise ??= (async () => {
    const decoder = new ZSTDDecoder();
    await decoder.init();
    return {
      ...defaultCompressors,
      ZSTD: (input: Uint8Array, outputLength: number): Uint8Array => {
        const output = decoder.decode(input, outputLength);
        if (output.byteLength !== outputLength) {
          throw new Error(`ZSTD produced ${output.byteLength} bytes; expected ${outputLength}`);
        }
        return output;
      },
    };
  })();
  return compressorPromise;
}
