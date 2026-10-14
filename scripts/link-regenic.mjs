import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const required = process.argv.includes("--required");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  process.env.REGENIC_ROOT?.trim(),
  join(repoRoot, "regenic"),
  resolve(repoRoot, "../regenic"),
].filter((value) => Boolean(value));

const root = candidates.find((candidate) =>
  existsSync(join(candidate, "packages", "connector-contract", "package.json")),
);

if (!root) {
  const message =
    "Regenic checkout not found. Set REGENIC_ROOT to the regenic repository.";
  if (required) {
    console.error(message);
    process.exit(1);
  }
  console.warn(message);
  process.exit(0);
}

const packages = ["plugin-host", "connector-contract", "connector-test-utils"];
const dest = join(repoRoot, "node_modules", "@regenic");
mkdirSync(dest, { recursive: true });
for (const name of packages) {
  const target = join(root, "packages", name);
  const link = join(dest, name);
  removePath(link);
  symlinkSync(target, link, "dir");
}
console.log(`Linked @regenic packages from ${root}`);

function removePath(link) {
  if (!existsSync(link)) {
    return;
  }
  if (lstatSync(link).isSymbolicLink()) {
    unlinkSync(link);
    return;
  }
  rmSync(link, { recursive: true, force: true });
}
