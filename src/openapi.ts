// `npm run openapi`: writes the API description generated from the routes (src/app.ts) to
// openapi.json. The file is committed: the platform reads it to show other apps what they can
// call, and CI fails when it no longer matches the routes.
import { writeFileSync } from "node:fs";
import { openapi } from "./app.js";

writeFileSync("openapi.json", `${JSON.stringify(openapi(), null, 2)}\n`);
process.exit(0); // the app module may hold a database open
