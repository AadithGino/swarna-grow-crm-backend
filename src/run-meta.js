import { connect, loop } from "./bootstrap.js";
import { leased } from "./health.js";
import { ingestMeta, reconcileMeta } from "./meta.js";
await connect();
let last = 0;
loop(
  () =>
    leased(
      "meta",
      async () => {
        await ingestMeta();
        if (Date.now() - last > 15 * 60000) {
          await reconcileMeta();
          last = Date.now();
        }
      },
      300000
    ),
  15000
);
