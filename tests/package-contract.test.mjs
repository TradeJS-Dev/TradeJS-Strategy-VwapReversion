import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("TradeJS runtime packages are provided by the Project host", () => {
  const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const runtimeDependencies = Object.keys(manifest.dependencies ?? {}).filter(
    (name) => name.startsWith("@tradejs/"),
  );
  const developmentRuntimePackages = Object.keys(
    manifest.devDependencies ?? {},
  ).filter((name) => name.startsWith("@tradejs/"));

  assert.deepEqual(runtimeDependencies, []);
  assert.ok(
    developmentRuntimePackages.every((name) =>
      Object.hasOwn(manifest.peerDependencies ?? {}, name),
    ),
  );
});

test("package ships built entrypoints and future backtest configurations", () => {
  const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
  for (const key of ["types", "import", "require"]) {
    assert.ok(fs.existsSync(manifest.exports["."][key]));
  }
  assert.deepEqual(manifest.files, ["dist", "examples"]);
  assert.equal(manifest.private, true);
  assert.ok(fs.existsSync("yarn.lock"));
});
