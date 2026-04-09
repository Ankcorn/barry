import { spawn } from "child_process";
import { createInterface } from "readline";
import { mkdir, readFile, writeFile, access, constants } from "fs/promises";
import { createWriteStream } from "fs";
import { randomBytes } from "crypto";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";

const app = new Hono();

// Block browser cross-origin requests — VPC service binding never sets Origin
app.use("*", async (c, next) => {
  if (c.req.header("Origin")) {
    return c.text("Forbidden", 403);
  }
  return next();
});

// ── bash ──────────────────────────────────────────────────────────────────────

const MAX_BYTES = 200 * 1024; // 200KB
const MAX_LINES = 2000;

function getTempFilePath(): string {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `barry-bash-${id}.log`);
}

/**
 * Slice a UTF-8 Buffer without splitting a multi-byte sequence.
 * Scans backwards from the cut point to find a safe boundary.
 */
function safeUtf8Slice(buf: Buffer, maxBytes: number, fromEnd = false): Buffer {
  const slice = fromEnd
    ? buf.slice(Math.max(0, buf.length - maxBytes))
    : buf.slice(0, Math.min(buf.length, maxBytes));

  if (slice.length === 0) return slice;

  // Find the start of a potentially incomplete multi-byte sequence at the boundary.
  // UTF-8 continuation bytes are 0x80–0xBF. Walk back until we hit a non-continuation byte.
  if (fromEnd) {
    // Check the first byte — if it's a continuation byte, skip forward to the next start byte.
    let i = 0;
    while (i < slice.length && (slice[i] & 0xc0) === 0x80) i++;
    return slice.slice(i);
  } else {
    // Check the last byte — walk back to find a leading byte.
    let i = slice.length - 1;
    while (i > 0 && (slice[i] & 0xc0) === 0x80) i--;
    // Check if the leading byte at i is complete (has enough continuation bytes after it).
    const b = slice[i];
    const seqLen =
      b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
    if (i + seqLen > slice.length) {
      // Incomplete sequence — drop it.
      return slice.slice(0, i);
    }
    return slice;
  }
}

/** Tail-truncate: keep the last MAX_LINES / MAX_BYTES of output */
function truncateTail(text: string): {
  content: string;
  truncated: boolean;
  totalLines: number;
  outputLines: number;
} {
  const lines = text.split("\n");
  const totalLines = lines.length;
  const byteLen = Buffer.byteLength(text, "utf-8");

  if (totalLines <= MAX_LINES && byteLen <= MAX_BYTES) {
    return { content: text, truncated: false, totalLines, outputLines: totalLines };
  }

  // Trim by lines first
  let selected = lines.slice(-MAX_LINES);
  let result = selected.join("\n");

  // Then trim by bytes if still too large
  if (Buffer.byteLength(result, "utf-8") > MAX_BYTES) {
    const buf = Buffer.from(result, "utf-8");
    const sliced = safeUtf8Slice(buf, MAX_BYTES, true);
    result = sliced.toString("utf-8");
    // Re-align to a line boundary
    const nl = result.indexOf("\n");
    if (nl !== -1) result = result.slice(nl + 1);
    selected = result.split("\n");
  }

  return { content: result, truncated: true, totalLines, outputLines: selected.length };
}

app.post("/bash", async (c) => {
  const { command, timeout } = await c.req.json<{
    command: string;
    timeout?: number; // seconds
  }>();

  return new Promise<Response>((resolve) => {
    let tempFilePath: string | undefined;
    let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
    let tempFileStreamEnded = false;
    let totalBytes = 0;
    let totalOutputLines = 0; // running count of all output lines, not just buffered
    const chunks: Buffer[] = [];
    let chunksBytes = 0;
    const maxChunksBytes = MAX_BYTES * 2;

    const child = spawn("/bin/bash", ["-c", command], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    if (timeout !== undefined && timeout > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        if (child.pid) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }
      }, timeout * 1000);
    }

    function endTempStream() {
      if (tempFileStream && !tempFileStreamEnded) {
        tempFileStreamEnded = true;
        tempFileStream.end();
      }
    }

    const handleData = (data: Buffer) => {
      totalBytes += data.length;
      totalOutputLines += data.toString("utf-8").split("\n").length - 1;

      // Spill to temp file once output exceeds the in-memory threshold
      if (totalBytes > MAX_BYTES && !tempFilePath) {
        tempFilePath = getTempFilePath();
        tempFileStream = createWriteStream(tempFilePath);
        for (const chunk of chunks) tempFileStream.write(chunk);
      }
      if (tempFileStream) tempFileStream.write(data);

      chunks.push(data);
      chunksBytes += data.length;
      while (chunksBytes > maxChunksBytes && chunks.length > 1) {
        const removed = chunks.shift()!;
        chunksBytes -= removed.length;
      }
    };

    child.stdout?.on("data", handleData);
    child.stderr?.on("data", handleData);

    child.on("error", (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      endTempStream();
      resolve(c.json({ stdout: "", stderr: err.message, exitCode: 1 }));
    });

    child.on("close", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      endTempStream();

      const fullOutput = Buffer.concat(chunks).toString("utf-8");
      const { content, truncated, outputLines } = truncateTail(fullOutput);

      let text = content || "(no output)";
      if (timedOut) {
        text += `\n\n[Command timed out after ${timeout} seconds]`;
      } else if (truncated) {
        const startLine = totalOutputLines - outputLines + 1;
        text += `\n\n[Showing lines ${startLine}-${totalOutputLines} of ${totalOutputLines}. Full output: ${tempFilePath}]`;
      }

      const exitCode = timedOut ? 124 : (code ?? 1);
      resolve(c.json({ stdout: text, stderr: "", exitCode, fullOutputPath: tempFilePath }));
    });
  });
});

// ── read ──────────────────────────────────────────────────────────────────────

const READ_MAX_LINES = 2000;
const READ_MAX_BYTES = 200 * 1024;

app.post("/read", async (c) => {
  const { path, offset, limit } = await c.req.json<{
    path: string;
    offset?: number;
    limit?: number;
  }>();

  try {
    await access(path, constants.R_OK);
  } catch {
    return c.json({ error: `Cannot read file: ${path}` }, 400);
  }

  const buffer = await readFile(path);
  const text = buffer.toString("utf-8");
  const allLines = text.split("\n");
  const totalLines = allLines.length;

  const startLine = offset ? Math.max(0, offset - 1) : 0;
  if (startLine >= allLines.length) {
    return c.json({ error: `Offset ${offset} is beyond end of file (${totalLines} lines)` }, 400);
  }

  const effectiveLimit = limit ?? READ_MAX_LINES;
  const endLine = Math.min(startLine + effectiveLimit, allLines.length);
  const selectedLines = allLines.slice(startLine, endLine);
  let content = selectedLines.join("\n");

  let truncated = false;
  let linesShown = selectedLines.length;

  if (Buffer.byteLength(content, "utf-8") > READ_MAX_BYTES) {
    const buf = Buffer.from(content, "utf-8");
    const sliced = safeUtf8Slice(buf, READ_MAX_BYTES, false);
    content = sliced.toString("utf-8");
    // Recount lines actually shown after byte truncation
    linesShown = content.split("\n").length;
    truncated = true;
  }

  const nextOffset = startLine + linesShown + 1;
  const hasMore = endLine < allLines.length || truncated;

  return c.json({
    content,
    totalLines,
    linesShown,
    startLine: startLine + 1,
    endLine: startLine + linesShown,
    truncated,
    hasMore,
    nextOffset: hasMore ? nextOffset : undefined,
  });
});

// ── write ─────────────────────────────────────────────────────────────────────

app.post("/write", async (c) => {
  const { path, content } = await c.req.json<{
    path: string;
    content: string;
  }>();

  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf-8");
    return c.json({ success: true, bytesWritten: Buffer.byteLength(content, "utf-8") });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

// ── grep ──────────────────────────────────────────────────────────────────────

const GREP_TIMEOUT_MS = 60_000; // 60s max for a grep

app.post("/grep", async (c) => {
  const { pattern, path: searchPath = ".", glob, ignoreCase, literal, context, limit = 100 } =
    await c.req.json<{
      pattern: string;
      path?: string;
      glob?: string;
      ignoreCase?: boolean;
      literal?: boolean;
      context?: number;
      limit?: number;
    }>();

  return new Promise<Response>((resolve) => {
    const args: string[] = ["--json", "--line-number", "--color=never", "--hidden"];
    if (ignoreCase) args.push("--ignore-case");
    if (literal) args.push("--fixed-strings");
    if (glob) args.push("--glob", glob);
    if (context && context > 0) args.push("--context", String(context));
    args.push(pattern, searchPath);

    const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });

    // Drain stderr so it never fills the pipe buffer and blocks rg
    child.stderr?.resume();

    const rl = createInterface({ input: child.stdout });

    let settled = false;
    let matchCount = 0;
    let limitReached = false;
    const matches: Array<{ file: string; line: number; text: string }> = [];

    const grepTimeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        rl.close();
        resolve(c.json({ error: `grep timed out after ${GREP_TIMEOUT_MS / 1000}s` }, 504));
      }
    }, GREP_TIMEOUT_MS);

    rl.on("line", (line) => {
      if (!line.trim() || limitReached) return;
      let event: { type: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === "match") {
        matchCount++;
        const file = event.data?.path?.text ?? "";
        const lineNum = event.data?.line_number ?? 0;
        const text = (event.data?.lines?.text ?? "").replace(/\r?\n$/, "");
        matches.push({ file, line: lineNum, text });
        if (matchCount >= limit) {
          limitReached = true;
          child.kill();
        }
      }
    });

    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(grepTimeout);
      rl.close();
      if (matches.length === 0) {
        resolve(c.json({ output: "No matches found", matchCount: 0, limitReached: false }));
        return;
      }
      const output = matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join("\n");
      resolve(c.json({ output, matchCount: matches.length, limitReached }));
    });

    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(grepTimeout);
      rl.close();
      resolve(c.json({ error: "ripgrep (rg) not found — install with: sudo apt install ripgrep" }, 500));
    });
  });
});

// ── start ─────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT || 3000);
serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`barry listening on port ${PORT}`);
});
