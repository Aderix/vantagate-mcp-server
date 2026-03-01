# VantaGate MCP Server & OpenAPI Integration

[![npm version](https://img.shields.io/npm/v/@vantagate/mcp-server)](https://www.npmjs.com/package/@vantagate/mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

> **Human-in-the-Loop authorization for AI Agents.** VantaGate intercepts high-risk actions, routes them to a human approver via Slack or Email, and returns a cryptographically-signed decision - so your agent resumes or halts with a full audit trail.

---

## What is VantaGate?

AI agents are increasingly capable of executing consequential real-world actions: sending emails to thousands of users, deleting database records, moving money, deploying to production. **VantaGate is the trust layer that ensures humans remain in control.**

```
Agent hits risky action
        ↓
POST /v1/checkpoint  ──→  Human receives Slack/Email notification
        ↓                          ↓
   id + dashboard_url    Human reviews payload & decides
        ↓                          ↓
Poll GET /v1/checkpoint/{id}  ←──  Decision recorded + payload purged
        ↓
   APPROVED → Resume workflow
   REJECTED → Halt + report reason
```

### Key Guarantees

- **< 100ms API response** - your agent is never blocked waiting for I/O
- **AES-256 payload encryption** at rest - payload is permanently destroyed after the decision
- **Zero-Retention polling** - `GET /checkpoint/{id}` never returns the original payload
- **Cryptographic audit trail** - every decision is HMAC-SHA256 signed
- **Stateless protocol** - no SDK required; plain HTTP from any language

---

## This Package

This package ships **two integration artifacts** for connecting any AI agent to VantaGate:

| Artifact | File | Best for |
|---|---|---|
| **OpenAPI 3.0 Spec** | `vanta-gate-openapi.json` | No-code tools, OpenAI GPTs, Alice, n8n, Zapier |
| **MCP Server** | `src/index.ts` / `dist/index.js` | Claude Desktop, Cursor, Cline, any MCP-compatible agent |

---

## Prerequisites

- Node.js >= 20
- A VantaGate account: [https://vanta-gate.com](https://vanta-gate.com)
- A VantaGate API key (Dashboard → Projects → New Project)

---

## Quick Start

### Option A: Use the MCP Server with Claude Desktop

The fastest path. No manual setup required.

**Step 1:** Get your API key from [https://vanta-gate.com/dashboard/projects](https://vanta-gate.com/dashboard/projects)

**Step 2:** Add VantaGate to your Claude Desktop config.

Open your `claude_desktop_config.json`:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "vantagate": {
      "command": "npx",
      "args": ["-y", "@vantagate/mcp-server"],
      "env": {
        "VANTA_API_KEY": "YOUR_API_KEY_HERE"
      }
    }
  }
}
```

**Step 3:** Restart Claude Desktop. The tools `create_vantagate_checkpoint` and `check_vantagate_status` will appear in Claude's tool list.

**Step 4:** Ask Claude to do something that requires approval:

> *"Delete all records from the staging database where created_at < 2024-01-01"*

Claude will automatically pause, create a checkpoint, and tell you to visit the `dashboard_url` to approve or reject.

---

### Option B: Use the OpenAPI Spec (No-Code / Low-Code)

Import `vanta-gate-openapi.json` directly into your tool of choice.

#### OpenAI GPTs / Custom Actions

1. Open your GPT editor at [https://platform.openai.com/gpts](https://platform.openai.com/gpts)
2. Click **"Add actions"** → **"Import from URL"** or paste the JSON
3. Set **Authentication** → `API Key` → Header: `X-API-KEY`
4. Enter your VantaGate API key

The GPT will now pause before high-risk tool calls and ask for human approval.

#### Alice (AI Agent Platform)

1. Go to **Integrations** → **Import OpenAPI**
2. Upload or paste `vanta-gate-openapi.json`
3. Set header `X-API-KEY` to your VantaGate API key in the credential store
4. Map `create_vantagate_checkpoint` to your agent's "before high-risk action" trigger

#### n8n / Zapier

1. Add an **HTTP Request** node
2. Import the OpenAPI spec to auto-populate endpoints
3. Set `X-API-KEY` header in the credential configuration

#### LangChain / LlamaIndex

```python
from langchain.tools import OpenAPITool

vanta_tool = OpenAPITool.from_openapi_spec(
    spec_path="./vanta-gate-openapi.json",
    headers={"X-API-KEY": os.environ["VANTA_API_KEY"]}
)
agent = initialize_agent([vanta_tool], llm, agent=AgentType.OPENAI_FUNCTIONS)
```

---

## Available MCP Tools

### `create_vantagate_checkpoint`

Pauses the agent workflow and routes a human approval request.

**When Claude uses it:** Before any high-risk action - financial operations, data deletion, production deployments, bulk communications.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `title` | string | ✅ | Short title shown to approver. Max 200 chars. |
| `payload` | object | ✅ | Full JSON context for the decision. Encrypted + purged after decision. |
| `description` | string | ❌ | Additional context below the title. Max 1000 chars. |
| `options` | string[] | ❌ | Decision options. First = approve action. Default: `["Approve", "Reject"]`. Min 2, max 5. |
| `timeout` | string | ❌ | Auto-expire duration: `30m`, `4h`, `2d`. Default: `24h`. |
| `notify_email` | string | ❌ | Email address for magic-link notification. |
| `slack_webhook_url` | string | ❌ | Slack webhook URL (Pro/Scale plans). From Dashboard → Add to Slack. |
| `callback_url` | string | ❌ | Your HTTPS endpoint for signed decision webhook. |

**Returns:** `checkpoint_id`, `dashboard_url`, and step-by-step instructions for the agent.

### `check_vantagate_status`

Polls the decision status of a pending checkpoint.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `checkpoint_id` | string | ✅ | The ID from `create_vantagate_checkpoint`. |

**Returns:** `status` (`PENDING` / `APPROVED` / `REJECTED` / `RESOLVED` / `EXPIRED`), `selected_option`, `reject_reason`, and the full audit trail.

---

## API Reference Summary

**Base URL:** `https://api.vanta-gate.com/v1`  
**Authentication:** `X-API-KEY` header

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/checkpoint` | Create a checkpoint - pauses agent |
| `GET` | `/checkpoint/{id}` | Poll for human decision |
| `GET` | `/checkpoint/secure/{token}` | Decision UI (internal - magic link) |
| `POST` | `/checkpoint/secure/{token}/decide` | Submit decision (internal - decision UI) |

### Checkpoint Status Lifecycle

```
PENDING → APPROVED   (human chose first/positive option)
        → REJECTED   (human rejected with optional reason)
        → RESOLVED   (human chose non-primary option)
        → EXPIRED    (timeout elapsed, no decision)
```

### Error Codes

| HTTP | Code | Description |
|---|---|---|
| 400 | `Invalid_Webhook_URL` | `slack_webhook_url` must start with `https://hooks.slack.com/` |
| 400 | `Invalid_Callback_URL` | `callback_url` is malformed or points to private IP |
| 400 | `Invalid_Decision` | Decision value not in checkpoint's options array |
| 400 | `Validation_Error` | Request body field validation failure |
| 401 | `Unauthorized` | Missing, invalid, or rotated API key |
| 402 | `Upgrade_Required` | Feature requires Pro or Scale plan |
| 403 | `Forbidden` | API key doesn't match the checkpoint's project |
| 404 | `Not_Found` | Checkpoint ID or token does not exist |
| 409 | `Already_Decided` | Decision already recorded for this checkpoint |
| 410 | `Checkpoint_Expired` | Timeout window has passed |
| 429 | `Rate_Limited` | Too many requests - back off and retry |

All errors follow the envelope:
```json
{
  "statusCode": 400,
  "error": "Machine_Readable_Code",
  "message": "Human-readable description."
}
```

---

## Subscription Tiers

| Feature | Free | Pro ($49/mo) | Scale ($199/mo) |
|---|---|---|---|
| Checkpoints/month | 50 | 2,500 | 25,000 |
| Email notifications | ✅ | ✅ | ✅ |
| Slack notifications | ❌ | ✅ | ✅ |
| Webhook callbacks | ✅ | ✅ | ✅ |
| Max timeout | 24h | 7 days | 30 days |
| Log retention | 7 days | 90 days | 365 days |

> Timeout values are silently clamped to your plan's maximum. A Free plan request with `timeout: "7d"` will be capped to `24h`.

---

## Webhooks

When a human decides, VantaGate sends a signed HTTPS POST to your `callback_url` (up to 5 retry attempts with exponential back-off).

**Request headers:**
```
Content-Type: application/json
X-Vanta-Signature: sha256=<HMAC-SHA256 of body>
User-Agent: VantaGate-Webhook/1.0
```

**Signature verification (Node.js):**
```javascript
const crypto = require('crypto')

function verifyVantaSignature(rawBody, signature, projectSecret) {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', projectSecret)
    .update(rawBody)
    .digest('hex')
  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signature)
  )
}

app.post('/webhook/vanta', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['x-vanta-signature']
  if (!verifyVantaSignature(req.body, sig, process.env.VANTA_PROJECT_SECRET)) {
    return res.status(401).json({ error: 'Invalid signature' })
  }
  const event = JSON.parse(req.body)
  if (event.status === 'APPROVED') {
    // ✅ Resume agent workflow
  } else if (event.status === 'REJECTED') {
    // ❌ Halt - check event.reject_reason
  }
  res.json({ received: true })
})
```

Your **Webhook Signing Secret** (`VANTA_PROJECT_SECRET`) is distinct from your API key. Find it in Dashboard → Project Settings.

---

## Building from Source

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run the server directly
VANTA_API_KEY=YOUR_API_KEY_HERE npm start
```

---

## Advanced: MCP Config for Other Clients

### Cursor / Cline / Windsurf

```json
{
  "mcpServers": {
    "vantagate": {
      "command": "npx",
      "args": ["-y", "@vantagate/mcp-server"],
      "env": {
        "VANTA_API_KEY": "YOUR_API_KEY_HERE"
      }
    }
  }
}
```

### With local build (development)

```json
{
  "mcpServers": {
    "vantagate": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"],
      "env": {
        "VANTA_API_KEY": "YOUR_API_KEY_HERE"
      }
    }
  }
}
```

---

## Security

- Your `X-API-KEY` is **hashed server-side** - VantaGate never stores plaintext keys.
- Your `slack_webhook_url` is sent per-request and **purged atomically** after the decision. Zero retention.
- All payload data is **encrypted at rest with AES-256** and destroyed after the human decision. It cannot be reconstructed.
- `callback_url` is validated against private IP ranges (SSRF prevention).
- All webhook deliveries are signed with **HMAC-SHA256**. Always verify signatures.

---

## License

MIT - see [LICENSE](LICENSE)

---

## Links

- **Dashboard:** [https://vanta-gate.com/dashboard](https://vanta-gate.com/dashboard)
- **Full API Docs:** [https://vanta-gate.com/dashboard/docs](https://vanta-gate.com/dashboard/docs)
- **Privacy Policy:** [https://vanta-gate.com/legal/privacy-policy](https://vanta-gate.com/legal/privacy-policy)
- **Terms of Service:** [https://vanta-gate.com/legal/terms-of-service](https://vanta-gate.com/legal/terms-of-service)
