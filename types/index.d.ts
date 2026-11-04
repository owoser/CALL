// Intentionally (almost) empty.
//
// Every declaration file vendored under types/lse/ heads with
//   /// <reference path="../index.d.ts" />
// which, in upstream's layout (platforms/javascript/src -> platforms/javascript/index.d.ts),
// points at a file that does not exist. In our vendored layout it resolves to THIS file.
// It exists purely so TypeScript does not report TS6053 for those references.
//
// Do not delete: `node scripts/fetch-types.mjs` regenerates types/lse/ but not this file.
export {};
