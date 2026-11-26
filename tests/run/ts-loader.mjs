// Lets plain `node --experimental-transform-types` run src/**/*.ts: a relative `./x.js` that does not exist
// resolves to `./x.ts` (the source imports use `.js` extensions). Used by driver-hup.mjs.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (e) {
      if (specifier.startsWith(".") && specifier.endsWith(".js")) return next(`${specifier.slice(0, -3)}.ts`, context);
      throw e;
    }
  },
});
