import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Logger } from "hatchlet";
import { z } from "zod";
import { handleAccessRequest } from "./access-handler";
import type { Props } from "./workers-oauth-utils";

const audit = new Logger();

const mcpHandler = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext & { props: Props },
  ): Promise<Response> {
    const props = ctx.props;
    if (props.email !== env.ALLOWED_EMAIL) {
      audit.warn`event=${"auth.forbidden"} email=${{email: props.email}}`;
      return new Response("Forbidden", { status: 403 });
    }

    const server = new McpServer(
      { name: "barry", version: "1.0.0" },
      {
        instructions:
          "You are an expert assistant with direct access to a Raspberry Pi (hostname: barry). " +
          "You can read files, write files, search file contents, and execute bash commands on the Pi. " +
          "Use read/write/grep for file operations and bash for everything else. " +
          "Prefer grep over bash for searching — it respects .gitignore and is faster.\n\n" +
          "The following CLI tools are available on this Pi:\n" +
          "- gh (v2.89.0): GitHub CLI, authenticated as Ankcorn. Use for managing repos, issues, PRs, etc.\n" +
          "- fnm (v1.39.0): Fast Node Manager at ~/.local/share/fnm/fnm. Node v24.14.1 available.\n" +
          "- node (v22.22.2): Node.js runtime (system install via NodeSource).\n" +
          "- npm (v10.9.7): Node package manager.\n" +
          "- cloudflared (v2026.3.0): Cloudflare tunnel daemon, running as a systemd service.\n" +
          "- git: Version control.\n" +
          "- curl / wget: HTTP clients.\n" +
          "- python3 / pip3: Python runtime and package manager.\n" +
          "- bash: Default shell for scripting and general command execution.\n\n" +
          "## Skills\n\n" +
          "Skills are sets of best-practice instructions for specific tasks. Before starting a task that matches a skill, read the SKILL.md file and follow its guidance.\n\n" +
          "Available skills (located in ~/skills/):\n" +
          "- playwright-skill (~/skills/playwright-skill/skills/playwright-skill/SKILL.md): Complete browser automation with Playwright. Use when testing websites, automating browser interactions, validating web functionality, filling forms, taking screenshots, or performing any browser-based task.",

      },
    );

    server.tool(
      "bash",
      "Execute a bash command on the Raspberry Pi. Returns the last 2000 lines / 200KB of output (tail-truncated — most recent output is preserved). If output is truncated, the full output path on the Pi is included. Optionally provide a timeout in seconds.",
      {
        command: z.string().describe("The bash command to execute"),
        timeout: z
          .number()
          .min(1)
          .max(3600)
          .optional()
          .describe("Timeout in seconds (no default — runs until completion)"),
      },
      async ({ command, timeout }) => {
        audit.info`event=${"tool.bash"} email=${{email: props.email}} command=${{command}}`;
        try {
          const response = await env.VPC_SERVICE.fetch(
            "http://localhost:3000/bash",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ command, timeout }),
            },
          );
          const result = (await response.json()) as {
            stdout: string;
            stderr: string;
            exitCode: number;
            fullOutputPath?: string;
          };
          if (result.exitCode !== 0) {
            audit.warn`event=${"tool.bash.error"} email=${{email: props.email}} command=${{command}} exitCode=${{exitCode: result.exitCode}}`;
          }
          const output = result.stdout + result.stderr;
          return {
            content: [{ type: "text", text: `exit ${result.exitCode}\n${output}` }],
          };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          audit.error`event=${"tool.bash.throw"} email=${{email: props.email}} command=${{command}} error=${{error}}`;
          throw err;
        }
      },
    );

    server.tool(
      "read",
      "Read the contents of a file on the Raspberry Pi. Output is truncated to 2000 lines or 200KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue reading with offset until complete.",
      {
        path: z
          .string()
          .describe("Path to the file to read (absolute or relative)"),
        offset: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Line number to start reading from (1-indexed)"),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Maximum number of lines to read (default 2000)"),
      },
      async ({ path, offset, limit }) => {
        audit.info`event=${"tool.read"} email=${{email: props.email}} path=${{path}}`;
        try {
          const response = await env.VPC_SERVICE.fetch(
            "http://localhost:3000/read",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path, offset, limit }),
            },
          );
          const result = (await response.json()) as {
            content?: string;
            error?: string;
            totalLines?: number;
            linesShown?: number;
            startLine?: number;
            endLine?: number;
            truncated?: boolean;
            hasMore?: boolean;
            nextOffset?: number;
          };
          if (result.error) {
            audit.warn`event=${"tool.read.error"} email=${{email: props.email}} path=${{path}} error=${{error: result.error}}`;
            return { content: [{ type: "text", text: `Error: ${result.error}` }] };
          }
          let text = result.content ?? "";
          if (result.hasMore) {
            text += `\n\n[Showing lines ${result.startLine}-${result.endLine} of ${result.totalLines}. Use offset=${result.nextOffset} to continue.]`;
          }
          return { content: [{ type: "text", text }] };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          audit.error`event=${"tool.read.throw"} email=${{email: props.email}} path=${{path}} error=${{error}}`;
          throw err;
        }
      },
    );

    server.tool(
      "write",
      "Write content to a file on the Raspberry Pi. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
      {
        path: z
          .string()
          .describe("Path to the file to write (absolute or relative)"),
        content: z.string().describe("Content to write to the file"),
      },
      async ({ path, content }) => {
        audit.info`event=${"tool.write"} email=${{email: props.email}} path=${{path}} bytes=${{bytes: new TextEncoder().encode(content).byteLength}}`;
        try {
          const response = await env.VPC_SERVICE.fetch(
            "http://localhost:3000/write",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path, content }),
            },
          );
          const result = (await response.json()) as {
            success?: boolean;
            bytesWritten?: number;
            error?: string;
          };
          if (result.error) {
            audit.warn`event=${"tool.write.error"} email=${{email: props.email}} path=${{path}} error=${{error: result.error}}`;
            return { content: [{ type: "text", text: `Error: ${result.error}` }] };
          }
          return {
            content: [{ type: "text", text: `Successfully wrote ${result.bytesWritten} bytes to ${path}` }],
          };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          audit.error`event=${"tool.write.throw"} email=${{email: props.email}} path=${{path}} error=${{error}}`;
          throw err;
        }
      },
    );

    server.tool(
      "grep",
      "Search file contents on the Raspberry Pi using ripgrep. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to 100 matches or 200KB (whichever is hit first). Long lines are truncated to 500 chars.",
      {
        pattern: z
          .string()
          .describe("Search pattern (regex or literal string)"),
        path: z
          .string()
          .optional()
          .describe("Directory or file to search (default: current directory)"),
        glob: z
          .string()
          .optional()
          .describe("Filter files by glob pattern, e.g. '*.ts' or '**/*.py'"),
        ignoreCase: z
          .boolean()
          .optional()
          .describe("Case-insensitive search (default: false)"),
        literal: z
          .boolean()
          .optional()
          .describe(
            "Treat pattern as literal string instead of regex (default: false)",
          ),
        context: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Number of lines to show before and after each match (default: 0)",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Maximum number of matches to return (default: 100)"),
      },
      async ({ pattern, path, glob, ignoreCase, literal, context, limit }) => {
        audit.info`event=${"tool.grep"} email=${{email: props.email}} pattern=${{pattern}} path=${{path: path ?? "."}}`;
        try {
          const response = await env.VPC_SERVICE.fetch(
            "http://localhost:3000/grep",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ pattern, path, glob, ignoreCase, literal, context, limit }),
            },
          );
          const result = (await response.json()) as {
            output?: string;
            matchCount?: number;
            limitReached?: boolean;
            error?: string;
          };
          if (result.error) {
            audit.warn`event=${"tool.grep.error"} email=${{email: props.email}} pattern=${{pattern}} error=${{error: result.error}}`;
            return { content: [{ type: "text", text: `Error: ${result.error}` }] };
          }
          let text = result.output ?? "No matches found";
          if (result.limitReached) {
            text += `\n\n[Limit of ${result.matchCount} matches reached. Use a more specific pattern or increase the limit.]`;
          }
          return { content: [{ type: "text", text }] };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          audit.error`event=${"tool.grep.throw"} email=${{email: props.email}} pattern=${{pattern}} error=${{error}}`;
          throw err;
        }
      },
    );

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};

export default new OAuthProvider({
  apiHandler: mcpHandler,
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  defaultHandler: handleAccessRequest,
  tokenEndpoint: "/token",
});
