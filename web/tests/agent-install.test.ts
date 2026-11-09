import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { token } from "../src/server/crypto";
import { agentInstallCommand, shellQuote } from "../src/lib/agent-install";

test("shell quoting preserves metacharacters as data", () => {
  const value = "a'$(printf INJECTED);\n\"\\b";
  assert.equal(
    execFileSync("bash", ["-c", `printf '%s' ${shellQuote(value)}`], { encoding: "utf8" }),
    value,
  );
});
test("copied install command carries the token on stdin, never curl/installer arguments", () => {
  const dir = mkdtempSync(join(tmpdir(), "blink-command-"));
  const secret = token();
  try {
    // Execute the actual generated shell command with a local download fixture.
    // Both subprocess wrappers reject a token in argv before running anything.
    writeFileSync(join(dir, "id"), "#!/bin/sh\nprintf '0\\n'\n", { mode: 0o755 });
    writeFileSync(
      join(dir, "sh"),
      `#!/bin/sh\ncase "$*" in *"$EXPECTED_TOKEN"*) exit 79;; esac\nexec /bin/sh "$@"\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(dir, "bash"),
      `#!/bin/bash\ncase "$*" in *"$EXPECTED_TOKEN"*) exit 80;; esac\nexec /bin/bash "$@"\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(dir, "curl"),
      `#!/bin/bash\ncase "$*" in *"$EXPECTED_TOKEN"*) exit 81;; esac\nwhile [[ $# -gt 0 ]]; do if [[ "$1" == -o ]]; then cp "$FIXTURE" "$2"; exit; fi; shift; done\nexit 82\n`,
      { mode: 0o755 },
    );
    const fixture = join(dir, "fixture.sh");
    writeFileSync(
      fixture,
      `#!/bin/bash\nIFS= read -r received\n[[ "$received" == "$EXPECTED_TOKEN" ]] || exit 83\n[[ "$*" == '--server https://blink.example.com --enable-terminal' ]] || exit 84\nprintf OK > "$RESULT"\n`,
    );
    execFileSync(
      "/bin/sh",
      ["-c", agentInstallCommand("https://blink.example.com", secret, true)],
      {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          EXPECTED_TOKEN: secret,
          FIXTURE: fixture,
          RESULT: join(dir, "result"),
        },
      },
    );
    assert.equal(readFileSync(join(dir, "result"), "utf8"), "OK");
    assert.throws(() => agentInstallCommand("https://blink.example.com/path", secret));
    assert.throws(() => agentInstallCommand("https://blink.example.com", "'; touch /tmp/pwned"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
