const fs = require("node:fs");
const path = require("node:path");

const outDir = path.join(__dirname, "..", "dist-electron");
for (const name of ["main", "preload"]) {
  const candidates = [
    path.join(outDir, `${name}.js`),
    path.join(outDir, "electron", `${name}.js`)
  ];
  const cjsPath = path.join(outDir, `${name}.cjs`);

  for (const jsPath of candidates) {
    if (fs.existsSync(jsPath)) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.rmSync(cjsPath, { force: true });
      fs.renameSync(jsPath, cjsPath);
      break;
    }
  }
}
