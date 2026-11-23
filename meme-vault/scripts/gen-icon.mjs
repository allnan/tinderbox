import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(projectRoot, "icon.png");
const master = path.join(projectRoot, "app-icon.png");

if (!fs.existsSync(source)) {
  throw new Error(`Missing approved icon source: ${source}`);
}

fs.copyFileSync(source, master);
console.log("Copied project-root icon.png to app-icon.png");
