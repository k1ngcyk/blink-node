/** Keep JSON frames below the gateway limit, without splitting a UTF-16 pair. */
export function* terminalInputChunks(data: string) {
  for (let start = 0; start < data.length;) {
    let end = Math.min(start + 2048, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
    yield data.slice(start, end);
    start = end;
  }
}

export function terminalControlKey(data: string) {
  if (data === " ") return "\x00";
  if (data === "?") return "\x7f";
  if (data.length === 1 && /[a-z@[\]\\^_]/i.test(data))
    return String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31);
  return data;
}

export function terminalArrowKey(direction: "A" | "B" | "C" | "D", applicationMode: boolean) {
  return `\x1b${applicationMode ? "O" : "["}${direction}`;
}
