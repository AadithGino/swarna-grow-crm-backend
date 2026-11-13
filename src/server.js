import "dotenv/config";
import { connect } from "./bootstrap.js";
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)
  throw Error("Set JWT_SECRET to 32+ random characters");
await connect();
const { app } = await import("./app.js");
app.listen(process.env.PORT || 4000, "0.0.0.0", () =>
  console.log(
    "SwarnaCRM API ready; run sales, meta, delivery and AI workers separately."
  )
);
