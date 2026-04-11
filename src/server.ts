import { spawn } from "child_process";
import { createWriteStream } from "fs";
import { randomBytes } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
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

  if (fromEnd) {
    let i = 0;
    while (i < slice.length && (slice[i] & 0xc0) === 0x80) i++;
    return slice.slice(i);
  } else {
    let i = slice.length - 1;
    while (i > 0 && (slice[i] & 0xc0) === 0x80) i--;
    const b = slice[i];
    const seqLen =
      b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
    if (i + seqLen > slice.length) {
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

  let selected = lines.slice(-MAX_LINES);
  let result = selected.join("\n");

  if (Buffer.byteLength(result, "utf-8") > MAX_BYTES) {
    const buf = Buffer.from(result, "utf-8");
    const sliced = safeUtf8Slice(buf, MAX_BYTES, true);
    result = sliced.toString("utf-8");
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
    let totalOutputLines = 0;
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

// ── start ─────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT || 3000);
serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`barry listening on port ${PORT}`);
});
