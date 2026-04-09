# barry

An MCP server that gives Claude direct access to a Raspberry Pi over a Cloudflare Tunnel.

## Architecture

```
Claude Desktop
    │
    ▼
Cloudflare Worker (gateway/)   ← OAuth via Cloudflare Access, MCP protocol
    │  VPC Service Binding
    ▼
Node.js HTTP Server (src/)     ← Runs on the Pi, exposes bash/read/write/grep
    │
    ▼
Raspberry Pi (barry)
```

The gateway Worker handles authentication and exposes the MCP tools. It proxies requests to the Node server running on the Pi via a Cloudflare Tunnel VPC service binding.

## Pi Setup

**1. Clone and install**
```bash
git clone https://github.com/Ankcorn/barry.git
cd barry
npm install && npm run build
```

**2. Install cloudflared and create a tunnel**

Follow the [Cloudflare Tunnel setup guide](https://developers.cloudflare.com/tunnel/setup/).

**3. Install cloudflared as a systemd service**
```bash
sudo cloudflared service install <YOUR_TUNNEL_TOKEN>
```

**4. Install the Barry MCP server as a systemd service**

Copy the unit file and enable it:
```bash
sudo cp barry.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now barry
```

This starts the Node.js server on port 3000 and ensures it runs on boot. The service will automatically restart on failure.

To check status or view logs:
```bash
sudo systemctl status barry
sudo journalctl -u barry -f
```

## Gateway Setup

The gateway is a Cloudflare Worker deployed via Wrangler. Set the following secrets:

```bash
cd gateway
npx wrangler secret put ACCESS_CLIENT_ID
npx wrangler secret put ACCESS_CLIENT_SECRET
npx wrangler secret put ACCESS_AUTHORIZATION_URL
npx wrangler secret put ACCESS_TOKEN_URL
npx wrangler secret put ACCESS_JWKS_URL
npx wrangler secret put COOKIE_ENCRYPTION_KEY
npx wrangler secret put ALLOWED_EMAIL
```

| Secret | Where to find it |
|--------|-----------------|
| `ACCESS_CLIENT_ID` | Cloudflare Access SaaS app → Client ID |
| `ACCESS_CLIENT_SECRET` | Cloudflare Access SaaS app → Client secret |
| `ACCESS_AUTHORIZATION_URL` | Cloudflare Access SaaS app → Authorization endpoint |
| `ACCESS_TOKEN_URL` | Cloudflare Access SaaS app → Token endpoint |
| `ACCESS_JWKS_URL` | Cloudflare Access SaaS app → Key endpoint |
| `COOKIE_ENCRYPTION_KEY` | Any random secret (used to sign cookies) |
| `ALLOWED_EMAIL` | The email address permitted to use the MCP server |

Also add `https://<your-worker-domain>/callback` as an allowed redirect URI in the Cloudflare Access SaaS app settings.

## Security

MCP clients authenticate via OAuth 2.1 ([Workers OAuth Provider](https://github.com/cloudflare/workers-oauth-provider)) with [Dynamic Client Registration (RFC 7591)](https://datatracker.ietf.org/doc/html/rfc7591) — no manual client setup needed. Authentication delegates to [Cloudflare Access SaaS MCP](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/saas-mcp/) backed by GitHub, and the `email` from the signed JWT is checked against `ALLOWED_EMAIL` before any tools are reachable. New clients see an approval dialog on first connect.

## MCP Endpoint

```
https://barry.ankcorn.dev/mcp
```

To deregister a client, delete the corresponding `client:<id>` key from the `OAUTH_KV` namespace via the Cloudflare dashboard or:

```bash
npx wrangler kv key delete "client:<id>" --namespace-id <namespace-id> --remote
```
