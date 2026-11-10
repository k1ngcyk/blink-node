import assert from "node:assert/strict";
import test from "node:test";
import {
  terminalArrowKey,
  terminalControlKey,
  terminalInputChunks,
} from "../src/lib/terminal-input";

test("terminal input frames preserve Unicode at chunk boundaries and fit the gateway", () => {
  const input = "a".repeat(2047) + "😀中文" + "\x00".repeat(12000) + "👩‍💻";
  const chunks = [...terminalInputChunks(input)];
  assert.equal(chunks.join(""), input);
  for (const chunk of chunks) {
    assert(chunk.length <= 2048);
    assert(Buffer.byteLength(JSON.stringify({ type: "input", data: chunk })) < 16384);
    assert.equal(
      Buffer.from(chunk).toString(),
      chunk,
      "each frame contains complete Unicode scalars",
    );
  }
  assert.deepEqual([...terminalInputChunks("")], []);
});

test("mobile Ctrl combinations preserve pasted text and non-Latin input", () => {
  for (const [key, expected] of [
    ["c", "\x03"],
    ["D", "\x04"],
    ["l", "\x0c"],
    ["[", "\x1b"],
    ["\\", "\x1c"],
    ["]", "\x1d"],
    [" ", "\x00"],
    ["?", "\x7f"],
  ])
    assert.equal(terminalControlKey(key), expected);
  for (const input of ["中文", "🙂", "ls -la", "\x1b[A"])
    assert.equal(terminalControlKey(input), input);
});

test("mobile arrow keys follow the application's cursor key mode", () => {
  assert.equal(terminalArrowKey("A", false), "\x1b[A");
  assert.equal(terminalArrowKey("D", true), "\x1bOD");
});
