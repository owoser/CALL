/// <reference path="../types/lse/index.d.ts" />
/**
 * Plugin entry point.
 *
 * NOTE: manifest.json's "entry" is index.js, which does `require("./core")`, so this
 * module is loaded as `core/index.js`. The historical comment about a directory
 * problem only applied to the old LiteLoaderBDS-nodejs loader; kept for context.
 */
import main from "./src/app";

mc.listen("onServerStarted", () => {
    main();
});
