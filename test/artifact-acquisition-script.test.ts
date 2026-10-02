import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("../scripts/acquire-formal-case-1.sh", import.meta.url).pathname;
const bashOnly = process.platform === "win32" ? "requires a POSIX Bash environment" : false;

test(
  "acquisition publishes raw and metadata only after curl success and 2xx",
  { skip: bashOnly },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "artifact-acquire-success-"));
    try {
      const fakeCurl = await writeFakeCurl(root, true);
      const result = spawnSync("bash", [script], {
        env: { ...process.env, OUTPUT_DIR: join(root, "out"), CURL_BIN: fakeCurl },
        encoding: "utf8"
      });
      assert.equal(result.status, 0, result.stderr);
      const files = await readdir(join(root, "out"));
      assert.equal(files.some((file) => file.includes(".tmp.")), false);
      for (const name of ["fed-statement", "fed-sep", "coinbase-btc-usd-1m"]) {
        assert.ok(files.includes(`${name}.raw`));
        assert.ok(files.includes(`${name}.headers.raw`));
        const metadata = JSON.parse(
          await readFile(join(root, "out", `${name}.metadata.json`), "utf8")
        );
        assert.equal(metadata.curlExitCode, 0);
        assert.equal(metadata.httpStatus, 200);
        assert.equal(Number.isFinite(metadata.retrievedAt), true);
        assert.match(metadata.rawSha256, /^[a-f0-9]{64}$/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

test(
  "acquisition removes temporary response data and emits no artifacts on failure",
  { skip: bashOnly },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "artifact-acquire-failure-"));
    try {
      const fakeCurl = await writeFakeCurl(root, false);
      const result = spawnSync("bash", [script], {
        env: { ...process.env, OUTPUT_DIR: join(root, "out"), CURL_BIN: fakeCurl },
        encoding: "utf8"
      });
      assert.equal(result.status, 1);
      assert.deepEqual(await readdir(join(root, "out")), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

async function writeFakeCurl(root: string, succeeds: boolean): Promise<string> {
  const path = join(root, "fake-curl.sh");
  await writeFile(path, `#!/usr/bin/env bash
set -u
headers=''
body=''
url=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dump-header) headers=$2; shift 2 ;;
    --output) body=$2; shift 2 ;;
    --write-out) shift 2 ;;
    -sS|-L) shift ;;
    *) url=$1; shift ;;
  esac
done
printf 'header' > "$headers"
printf 'body:%s' "$url" > "$body"
${succeeds ? "printf '200\\n%s' \"$url\"; exit 0" : "printf '403\\n%s' \"$url\"; exit 0"}
`);
  await chmod(path, 0o755);
  return path;
}
