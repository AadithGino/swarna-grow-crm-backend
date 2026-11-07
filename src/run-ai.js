import { connect, loop } from "./bootstrap.js";
import { leased } from "./health.js";
import { processJob } from "./worker.js";
await connect();
loop(() => leased("ai", () => processJob(), 15 * 60000), 1000);
