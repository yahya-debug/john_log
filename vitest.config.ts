import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Integration tests share one real Postgres instance and some of them
        // (via App()'s retain() side effect) sweep the *entire* logs_default
        // table — running test files in parallel lets one file's cron-like
        // sweep consume another file's in-flight fixtures before it asserts
        // on them. Unit tests don't need this, but the suite is fast enough
        // either way that running everything sequentially isn't worth a
        // separate config just to parallelize the cheap half.
        fileParallelism: false,
    },
});
