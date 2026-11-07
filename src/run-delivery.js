import { connect, loop } from "./bootstrap.js";
import { leased } from "./health.js";
import { deliverOne } from "./notifications.js";
await connect();
loop(
  () =>
    leased("delivery", async () => {
      for (let n = 0; n < 30; n++) if (!(await deliverOne())) break;
    }),
  5000
);
