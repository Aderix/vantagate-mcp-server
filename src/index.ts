#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// ─── Constants ────────────────────────────────────────────────────────────────

const VANTA_BASE_URL = "https://api.vanta-gate.com/v1";
const SERVER_NAME = "vantagate-mcp-server";
const SERVER_VERSION = "1.0.0";

// ─── Environment validation ────────────────────────────────────────────────────

const apiKey = process.env["VANTA_API_KEY"];

if (!apiKey || apiKey.trim() === "") {
  process.stderr.write(
    [
      "╔═══════════════════════════════════════════════════════════╗",
      "║          VantaGate MCP Server - Startup Error             ║",
      "╠═══════════════════════════════════════════════════════════╣",
      "║  VANTA_API_KEY environment variable is required.          ║",
      "║                                                           ║",
      "║  1. Go to: https://vanta-gate.com/dashboard/projects      ║",
      "║  2. Create or open a project                              ║",
      "║  3. Copy your API key (shown exactly once)                ║",
      "║  4. Set it in your MCP config:                            ║",
      '║     "env": { "VANTA_API_KEY": "vg_123..." }               ║',
      "╚═══════════════════════════════════════════════════════════╝",
    ].join("\n") + "\n"
  );
  process.exit(1);
}

// Narrow the type - we validated above
const VANTA_API_KEY: string = apiKey;

// ─── Zod schemas for tool arguments ──────────────────────────────────────────

const CreateCheckpointArgsSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(200)
    .describe("Short, human-readable title shown to the approver. Max 200 chars."),
  description: z
    .string()
    .max(1000)
    .optional()
    .describe("Additional context displayed below the title on the decision screen. Max 1000 chars."),
  payload: z
    .record(z.string(), z.unknown())
    .describe(
      "Arbitrary JSON object containing the full context for the approver. " +
        "Include all relevant data (amounts, IDs, user info, etc.). " +
        "Encrypted at rest with AES-256 and permanently destroyed after the decision."
    ),
  options: z
    .array(z.string())
    .min(2)
    .max(5)
    .optional()
    .describe(
      "Decision options shown to the approver. Min 2, max 5. " +
        "The FIRST element is always treated as the APPROVED/positive action. " +
        "Defaults to ['Approve', 'Reject']."
    ),
  timeout: z
    .string()
    .regex(/^\d+[hmd]$/)
    .optional()
    .describe(
      "Auto-expire duration. Format: {n}m | {n}h | {n}d (e.g. '30m', '4h', '2d'). " +
        "Defaults to '24h'. Capped by plan: Free→24h, Pro→7d, Scale→30d."
    ),
  notify_email: z
    .string()
    .email()
    .optional()
    .describe("Email address to send the magic-link approval request to."),
  slack_webhook_url: z
    .string()
    .url()
    .optional()
    .describe(
      "Slack Incoming Webhook URL (Pro/Scale plans only). " +
        "Obtain from Dashboard → 'Add to Slack'. Must start with https://hooks.slack.com/"
    ),
  callback_url: z
    .string()
    .url()
    .optional()
    .describe(
      "Your HTTPS endpoint to receive the signed decision webhook. " +
        "Optional - omit if polling GET /checkpoint/{id} instead."
    ),
});

const CheckStatusArgsSchema = z.object({
  checkpoint_id: z
    .string()
    .min(1)
    .describe("The checkpoint ID returned by create_vantagate_checkpoint."),
});

// ─── Type aliases ─────────────────────────────────────────────────────────────

type CreateCheckpointArgs = z.infer<typeof CreateCheckpointArgsSchema>;
type CheckStatusArgs = z.infer<typeof CheckStatusArgsSchema>;

interface CreateCheckpointResponse {
  id: string;
  status: "PENDING";
  secure_token: string;
  dashboard_url: string;
}

type CheckpointStatus = "PENDING" | "APPROVED" | "REJECTED" | "RESOLVED" | "EXPIRED";

interface PollPendingResponse {
  id: string;
  status: "PENDING";
  payload_hash: null;
}

interface PollDecidedResponse {
  id: string;
  status: CheckpointStatus;
  selected_option: string | null;
  reject_reason: string | null;
  payload_hash: string | null;
  audit: {
    decided_at: string | null;
    decided_by_mask: string | null;
    decided_by_slack_id: string | null;
  };
}

type PollResponse = PollPendingResponse | PollDecidedResponse;

interface VantaErrorBody {
  statusCode: number;
  error: string;
  message: string;
  upgrade_url?: string;
}

// ─── API client helpers ───────────────────────────────────────────────────────

async function vantaPost<T>(
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  const response = await fetch(`${VANTA_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": VANTA_API_KEY,
      "User-Agent": `${SERVER_NAME}/${SERVER_VERSION}`,
    },
    body: JSON.stringify(body),
  });

  const json = (await response.json()) as T | VantaErrorBody;

  if (!response.ok) {
    const err = json as VantaErrorBody;
    const upgradeHint =
      err.upgrade_url ? ` Upgrade at: ${err.upgrade_url}` : "";
    throw new McpError(
      ErrorCode.InternalError,
      `VantaGate API error ${response.status} [${err.error ?? "Unknown"}]: ${err.message ?? response.statusText}${upgradeHint}`
    );
  }

  return json as T;
}

async function vantaGet<T>(path: string): Promise<T> {
  const response = await fetch(`${VANTA_BASE_URL}${path}`, {
    method: "GET",
    headers: {
      "X-API-KEY": VANTA_API_KEY,
      "User-Agent": `${SERVER_NAME}/${SERVER_VERSION}`,
    },
  });

  const json = (await response.json()) as T | VantaErrorBody;

  if (!response.ok) {
    const err = json as VantaErrorBody;
    throw new McpError(
      ErrorCode.InternalError,
      `VantaGate API error ${response.status} [${err.error ?? "Unknown"}]: ${err.message ?? response.statusText}`
    );
  }

  return json as T;
}

// ─── Tool handlers ────────────────────────────────────────────────────────────

async function handleCreateCheckpoint(
  rawArgs: unknown
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const parseResult = CreateCheckpointArgsSchema.safeParse(rawArgs);

  if (!parseResult.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid arguments for create_vantagate_checkpoint: ${parseResult.error.message}`
    );
  }

  const args: CreateCheckpointArgs = parseResult.data;

  const requestBody: Record<string, unknown> = {
    title: args.title,
    payload: args.payload,
  };

  if (args.description !== undefined) requestBody["description"] = args.description;
  if (args.options !== undefined) requestBody["options"] = args.options;
  if (args.timeout !== undefined) requestBody["timeout"] = args.timeout;
  if (args.notify_email !== undefined) requestBody["notify_email"] = args.notify_email;
  if (args.slack_webhook_url !== undefined) requestBody["slack_webhook_url"] = args.slack_webhook_url;
  if (args.callback_url !== undefined) requestBody["callback_url"] = args.callback_url;

  const result = await vantaPost<CreateCheckpointResponse>(
    "/checkpoint",
    requestBody
  );

  const optionsList = args.options ?? ["Approve", "Reject"];
  const timeoutInfo = args.timeout ?? "24h";

  const text = [
    "✅ VantaGate Checkpoint Created - Workflow Paused",
    "",
    `📋 Checkpoint ID : ${result.id}`,
    `📊 Status        : ${result.status}`,
    `🔗 Decision URL  : ${result.dashboard_url}`,
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "⏭️  NEXT STEPS FOR AGENT:",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    "1. Inform the user:",
    `   "I have paused this action for human approval. Please visit:`,
    `   ${result.dashboard_url}`,
    `   to review and decide."`,
    "",
    "2. Call check_vantagate_status with:",
    `   checkpoint_id: "${result.id}"`,
    "",
    "3. Poll every 5-10 seconds until status is no longer PENDING.",
    "",
    "4. Decision logic:",
    `   • APPROVED (user chose "${optionsList[0] ?? "Approve"}") → Resume workflow`,
    `   • REJECTED → Halt and report reject_reason to user`,
    `   • RESOLVED → Check selected_option for routing`,
    `   • EXPIRED  → Action blocked (timeout: ${timeoutInfo})`,
    "",
    "⚠️  DO NOT proceed with the original action until status is APPROVED.",
  ].join("\n");

  return { content: [{ type: "text", text }] };
}

async function handleCheckStatus(
  rawArgs: unknown
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const parseResult = CheckStatusArgsSchema.safeParse(rawArgs);

  if (!parseResult.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid arguments for check_vantagate_status: ${parseResult.error.message}`
    );
  }

  const args: CheckStatusArgs = parseResult.data;
  const result = await vantaGet<PollResponse>(
    `/checkpoint/${encodeURIComponent(args.checkpoint_id)}`
  );

  if (result.status === "PENDING") {
    return {
      content: [
        {
          type: "text",
          text: [
            "⏳ VantaGate Status: PENDING - Still waiting for human decision",
            "",
            `📋 Checkpoint ID : ${result.id}`,
            `📊 Status        : PENDING`,
            "",
            "The human has not yet made a decision.",
            "→ Wait 5-10 seconds and call check_vantagate_status again.",
            "→ Do NOT proceed with the original action.",
          ].join("\n"),
        },
      ],
    };
  }

  const decided = result as PollDecidedResponse;
  const statusEmoji: Record<CheckpointStatus, string> = {
    PENDING: "⏳",
    APPROVED: "✅",
    REJECTED: "❌",
    RESOLVED: "🔄",
    EXPIRED: "⌛",
  };

  const emoji = statusEmoji[decided.status] ?? "❓";

  const actionInstruction: Record<CheckpointStatus, string> = {
    PENDING: "→ Keep polling.",
    APPROVED:
      "→ ✅ PROCEED: The human approved. Resume your workflow immediately.",
    REJECTED:
      "→ ❌ HALT: The human rejected this action. Do NOT proceed. Inform the user with the reject_reason above.",
    RESOLVED:
      "→ 🔄 ROUTE: The human selected a non-primary option. Check selected_option above and route your workflow accordingly.",
    EXPIRED:
      "→ ⌛ BLOCKED: The approval window expired with no decision. This action has been implicitly blocked. Do NOT proceed.",
  };

  const lines = [
    `${emoji} VantaGate Status: ${decided.status}`,
    "",
    `📋 Checkpoint ID  : ${decided.id}`,
    `📊 Status         : ${decided.status}`,
    `☑️  Selected Option: ${decided.selected_option ?? "N/A"}`,
  ];

  if (decided.reject_reason) {
    lines.push(`💬 Reject Reason  : ${decided.reject_reason}`);
  }

  if (decided.payload_hash) {
    lines.push(`🔐 Payload Hash   : ${decided.payload_hash}`);
  }

  if (decided.audit) {
    lines.push("", "📁 Audit Trail:");
    if (decided.audit.decided_at) {
      lines.push(`   • Decided at     : ${decided.audit.decided_at}`);
    }
    if (decided.audit.decided_by_mask) {
      lines.push(`   • Decided by     : ${decided.audit.decided_by_mask}`);
    }
    if (decided.audit.decided_by_slack_id) {
      lines.push(`   • Slack user     : ${decided.audit.decided_by_slack_id}`);
    }
  }

  lines.push("", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(actionInstruction[decided.status] ?? "→ Unexpected status. Do not proceed without verification.");

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// ─── MCP Server Factory ───────────────────────────────────────────────────────

/**
 * Creates and configures a new Server instance.
 * Encapsulating this in a factory function prevents "Already connected to a transport"
 * errors when Smithery attempts to scan the server capabilities.
 */
function buildServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "create_vantagate_checkpoint",
          description:
            "🛑 PAUSE WORKFLOW - Request human approval before a high-risk action.\n\n" +
            "Call this tool BEFORE executing any action that is:\n" +
            "  • High-value (financial transactions, budget approvals)\n" +
            "  • Irreversible (deleting data, dropping tables, sending bulk emails)\n" +
            "  • High-impact (production deployments, permission changes, external API calls with side effects)\n" +
            "  • Sensitive (accessing PII, escalating privileges)\n\n" +
            "This tool will:\n" +
            "  1. Freeze your workflow and create a secure approval checkpoint\n" +
            "  2. Notify a human reviewer via Slack and/or Email with the full context\n" +
            "  3. Return a checkpoint_id and dashboard_url\n\n" +
            "After calling this tool:\n" +
            "  → Inform the user to visit the dashboard_url to approve or reject\n" +
            "  → Call check_vantagate_status every 5-10s until status ≠ PENDING\n" +
            "  → Only proceed if status is APPROVED\n\n" +
            "Never skip this tool for high-risk actions. Human oversight is required.",
          inputSchema: {
            type: "object",
            required: ["title", "payload"],
            properties: {
              title: {
                type: "string",
                maxLength: 200,
                description:
                  "Short, human-readable title shown to the approver. Be specific. E.g. 'Delete production users table' not just 'Database operation'.",
              },
              description: {
                type: "string",
                maxLength: 1000,
                description:
                  "Additional context for the approver. Explain WHY this action is needed and what the consequences are.",
              },
              payload: {
                type: "object",
                additionalProperties: true,
                description:
                  "All relevant context as a JSON object. Include amounts, IDs, affected resources, risk assessment - everything the human needs to make an informed decision.",
              },
              options: {
                type: "array",
                items: { type: "string" },
                minItems: 2,
                maxItems: 5,
                description:
                  "Decision options for the approver. FIRST option = positive/approve action. E.g. ['Deploy to Production', 'Cancel Deployment']. Defaults to ['Approve', 'Reject'].",
              },
              timeout: {
                type: "string",
                pattern: "^\\d+[hmd]$",
                description:
                  "How long to wait for a decision before auto-expiring. Format: 30m, 4h, 2d. Defaults to 24h.",
              },
              notify_email: {
                type: "string",
                format: "email",
                description:
                  "Email of the human approver. They will receive a magic-link to the decision UI.",
              },
              slack_webhook_url: {
                type: "string",
                format: "uri",
                description:
                  "Slack Incoming Webhook URL (Pro/Scale plans). Sends a rich interactive Slack message.",
              },
              callback_url: {
                type: "string",
                format: "uri",
                description:
                  "Your HTTPS webhook endpoint to receive the signed decision. Optional if polling.",
              },
            },
          },
        },
        {
          name: "check_vantagate_status",
          description:
            "⏳ CHECK DECISION - Poll the status of a pending VantaGate checkpoint.\n\n" +
            "Call this tool after create_vantagate_checkpoint to check if the human has decided.\n\n" +
            "Polling behaviour:\n" +
            "  • If status = PENDING → human has not decided yet. Wait 5-10s and call again.\n" +
            "  • If status = APPROVED → human approved. Proceed with the original action.\n" +
            "  • If status = REJECTED → human rejected. DO NOT proceed. Report reject_reason to user.\n" +
            "  • If status = RESOLVED → human chose a non-primary option. Check selected_option.\n" +
            "  • If status = EXPIRED → timeout elapsed. Action is blocked. Do NOT proceed.\n\n" +
            "This endpoint enforces Zero-Retention - it returns only the decision status, never the original payload (which is permanently destroyed).",
          inputSchema: {
            type: "object",
            required: ["checkpoint_id"],
            properties: {
              checkpoint_id: {
                type: "string",
                description:
                  "The checkpoint ID returned by create_vantagate_checkpoint (e.g. 'chk_a1b2c3d4e5f6').",
              },
            },
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "create_vantagate_checkpoint":
        return handleCreateCheckpoint(args);

      case "check_vantagate_status":
        return handleCheckStatus(args);

      default:
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: "${name}". Available tools: create_vantagate_checkpoint, check_vantagate_status`
        );
    }
  });

  return server;
}

// ─── Smithery Scanner Support ─────────────────────────────────────────────────

/**
 * Export a factory function for Smithery.
 * This allows Smithery to instantiate a fresh server without side-effects (transports).
 */
export function createSandboxServer() {
  return buildServer();
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Secure masking: vanta_********123a 
  const prefix = VANTA_API_KEY.substring(0, 6);
  const suffix = VANTA_API_KEY.slice(-4);
  const maskedKey = `${prefix}********${suffix}`;

  process.stderr.write(
    `${SERVER_NAME} v${SERVER_VERSION} running on stdio. API key: ${maskedKey}\n`
  );
}

// Only execute main() if this script is run directly from the command line
// This prevents execution when Smithery imports this file to scan capabilities.
if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `Fatal error starting ${SERVER_NAME}: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  });
}