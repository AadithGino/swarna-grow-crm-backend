import { connect, loop } from "./bootstrap.js";
import { leased } from "./health.js";
import { sweep } from "./workflow.js";
import { operationsSweep } from "./operations.js";
import { initializeDemo } from "./demoFlow.js";
import { Demo } from "./models.js";
await connect();
loop(
  () =>
    leased("sales", async () => {
      await sweep();
      for (const d of await Demo.find({
        stageDueAt: null,
        status: { $ne: "responded" },
      }))
        await initializeDemo(d.id);
      await operationsSweep();
    }),
  15000
);
