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

The gateway is a Cloudflare Worker deployed via Git. Set the following secrets in the Cloudflare dashboard:

| Secret | Description |
|--------|-------------|
| `ACCESS_CLIENT_ID` | Cloudflare Access service token client ID |
| `ACCESS_CLIENT_SECRET` | Cloudflare Access service token client secret |
| `ACCESS_ISSUER` | Cloudflare Access issuer URL |
| `ALLOWED_EMAIL` | The email address permitted to use the MCP server |

## MCP Endpoint

```
https://barry.ankcorn.dev/mcp
```
