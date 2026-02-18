# Phantom MCP Host - Fly.io Deployment

Hosted REST shim for @phantom/mcp-server. Deployed on Fly.io and called by the Convex backend.

## Deploy to Fly.io

### Prerequisites
- Install Fly CLI: `brew install flyctl` (macOS) or visit https://fly.io/docs/hands-on/install-flyctl/
- Login: `fly auth login`

### Deployment Steps

1. **Launch the app** (first time only):
```bash
cd apps/mcp-host
fly launch
```
This will:
- Create a new Fly.io app
- Set up the Dockerfile deployment
- Ask you to set environment variables

2. **Set environment variables**:
```bash
fly secrets set PHANTOM_APP_ID=your_phantom_app_id
fly secrets set PHANTOM_MCP_SHARED_SECRET=your_secret_here
```

3. **Deploy**:
```bash
fly deploy
```

4. **Check status**:
```bash
fly status
fly logs
```

5. **Get the URL**:
```bash
fly info
```
Use the `Hostname` (e.g., `phantom-agent-mcp.fly.dev`) in your Convex environment variables.

## Environment Variables

Required:
- `PHANTOM_APP_ID` - Your Phantom Portal application ID
- `PHANTOM_MCP_SHARED_SECRET` - Shared secret between this server and Convex backend

Optional:
- `PORT` - HTTP port (default: 8080, set by Fly.io)
- `PHANTOM_API_BASE_URL` - Phantom API base URL (default: https://api.phantom.app)

## Endpoints

- `POST /call` - Execute MCP tool calls
- `POST /resolve-approval` - Resolve approval requests  
- `GET /health` - Health check

## Updating

After making changes:
```bash
fly deploy
```

## Scaling

Fly.io automatically scales based on traffic with the configuration in `fly.toml`:
- Min machines: 1 (always running)
- Auto-starts on request
- Auto-suspends when idle
