import assert from "node:assert/strict";
import test from "node:test";
import { operatingSystem } from "../src/lib/operating-system";

test("recognizes reported OS versions without confusing architectures or guessing unknown distributions", () => {
  for (const [input, expected] of [
    ["Ubuntu 24.04.3 LTS", "ubuntu"],
    ["Debian GNU/Linux 13 (trixie)", "debian"],
    ["Alpine Linux v3.22", "alpine"],
    ["Rocky Linux 9.6", "rocky"],
    ["Red Hat Enterprise Linux 9", "redhat"],
    ["Arch Linux", "arch"],
    ["CentOS Stream 10", "centos"],
    ["macOS 27.2", "macos"],
    ["Linux aarch64", "generic"],
    ["Custom OS", "generic"],
    ["", "pending"],
  ])
    assert.equal(operatingSystem(input), expected, input);
  assert.equal(operatingSystem(undefined), "pending");
});
