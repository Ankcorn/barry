import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Logger } from "hatchlet";
import { z } from "zod";
import { cloudflareAccessApp } from "./access-handler";
import type { Props } from "./workers-oauth-utils";

const audit = new Logger();

const BASH_TOOL_PARAMS = {
  command: z.string().describe("The bash command to execute"),
  timeout: z
    .number()
    .min(1)
    .max(3600)
    .optional()
    .describe("Timeout in seconds (no default — runs until completion)"),
};

async function executeBash(
  service: Fetcher,
  command: string,
  timeout?: number,
): Promise<{ text: string }> {
  const response = await service.fetch("http://localhost:3000/bash", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, timeout }),
  });
  const result = (await response.json()) as {
    stdout: string;
    stderr: string;
    exitCode: number;
    fullOutputPath?: string;
  };
  const output = result.stdout + result.stderr;
  return { text: `exit ${result.exitCode}\n${output}` };
}

const mcpHandler = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext & { props: Props },
  ): Promise<Response> {
    const props = ctx.props;
    if (props.email !== env.ALLOWED_EMAIL) {
      audit.warn`event=${"auth.forbidden"} email=${{ email: props.email }}`;
      return new Response("Forbidden", { status: 403 });
    }

    const server = new McpServer(
      { name: "barry", version: "1.0.0" },
      {
        instructions:
          "You have direct shell access to two Raspberry Pis:\n" +
          "- barry: the primary Pi running this MCP server\n" +
          "- berry: a second Pi with its own independent server and Cloudflare Tunnel\n\n" +
          "Use bashBarry for commands on barry, bashBerry for commands on berry.\n" +
          "Both Pis run independently — there is no single point of failure.\n\n" +
          "Available CLI tools on both Pis:\n" +
          "- git, curl, wget, bash, python3/pip3\n\n" +
          "Additional tools on barry:\n" +
          "- gh (v2.89.0): GitHub CLI, authenticated as Ankcorn\n" +
          "- fnm / node (v24) / npm\n" +
          "- cloudflared (v2026.3.0)\n\n" +
          "## Skills\n\n" +
          "Skills are sets of best-practice instructions for specific tasks. Before starting a task that matches a skill, read the SKILL.md file and follow its guidance.\n\n" +
          "Available skills (located in ~/skills/ on barry):\n" +
          "- playwright-skill (~/skills/playwright-skill/skills/playwright-skill/SKILL.md): Complete browser automation with Playwright.",
      },
    );

    server.tool(
      "bashBarry",
      "Execute a bash command on barry (the primary Raspberry Pi). Returns the last 2000 lines / 200KB of output. Optionally provide a timeout in seconds.",
      BASH_TOOL_PARAMS,
      async ({ command, timeout }) => {
        audit.info`event=${"tool.bashBarry"} email=${{ email: props.email }} command=${{ command }}`;
        try {
          const { text } = await executeBash(env.BARRY_VPC_SERVICE, command, timeout);
          return { content: [{ type: "text", text }] };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          audit.error`event=${"tool.bashBarry.throw"} email=${{ email: props.email }} command=${{ command }} error=${{ error }}`;
          throw err;
        }
      },
    );

    server.tool(
      "bashBerry",
      "Execute a bash command on berry (a second independent Raspberry Pi with its own server). Returns the last 2000 lines / 200KB of output. Optionally provide a timeout in seconds.",
      BASH_TOOL_PARAMS,
      async ({ command, timeout }) => {
        audit.info`event=${"tool.bashBerry"} email=${{ email: props.email }} command=${{ command }}`;
        try {
          const { text } = await executeBash(env.BERRY_VPC_SERVICE, command, timeout);
          return { content: [{ type: "text", text }] };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          audit.error`event=${"tool.bashBerry.throw"} email=${{ email: props.email }} command=${{ command }} error=${{ error }}`;
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
  clientRegistrationEndpoint: "/register",
  defaultHandler: cloudflareAccessApp as any,
  tokenEndpoint: "/token",
});
