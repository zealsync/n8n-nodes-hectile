import { createHmac, timingSafeEqual } from "crypto";
import {
  NodeApiError,
  NodeConnectionTypes,
  type IDataObject,
  type IHookFunctions,
  type INodeType,
  type INodeTypeDescription,
  type IWebhookFunctions,
  type IWebhookResponseData,
  type JsonObject,
} from "n8n-workflow";

// Hectile's webhook events (test/events.json lists them; a test keeps the two equal).
const EVENTS = [
  { name: "Credit Note Issued", value: "credit_note.issued" },
  { name: "Customer Created", value: "customer.created" },
  { name: "Customer Updated", value: "customer.updated" },
  { name: "Debit Note Issued", value: "debit_note.issued" },
  { name: "Estimate Accepted", value: "estimate.accepted" },
  { name: "Estimate Declined", value: "estimate.declined" },
  { name: "Invoice Issued", value: "invoice.issued" },
  { name: "Invoice Overdue", value: "invoice.overdue" },
  { name: "Invoice Paid", value: "invoice.paid" },
  { name: "Invoice Sent", value: "invoice.sent" },
  { name: "Payment Received", value: "payment.received" },
  { name: "Payment Refunded", value: "payment.refunded" },
];

/**
 * The HTTP status of a failed request, read from the error's own structure: n8n's request helpers throw a NodeApiError
 * whose cause is the HTTP client's error (`cause.response.status`) and whose `httpCode` holds the status as text; a
 * plain HTTP client error has `response.status`. Never read from the message. Undefined when no response arrived
 * (a network failure or a timeout).
 */
function failedStatus(error: unknown): number | undefined {
  const failure = error as { httpCode?: unknown; response?: { status?: unknown }; cause?: { response?: { status?: unknown } } } | undefined;
  for (const value of [failure?.cause?.response?.status, failure?.response?.status, failure?.httpCode]) {
    const status = typeof value === "number" ? value : typeof value === "string" && /^[1-5]\d\d$/.test(value) ? Number(value) : NaN;
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  return undefined;
}

/** The body Hectile answered a failed request with, if any (the same structure as above; NodeApiError keeps a copy in context.data). */
function failedBody(error: unknown): unknown {
  const failure = error as { response?: { data?: unknown }; cause?: { response?: { data?: unknown } }; context?: { data?: unknown } } | undefined;
  return failure?.cause?.response?.data ?? failure?.response?.data ?? failure?.context?.data;
}

/** Hectile's webhooks: subscribes its own URL with the key, checks each signature, unsubscribes when turned off. */
export class HectileTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Hectile Trigger",
    name: "hectileTrigger",
    icon: { light: "file:../../icons/hectile.svg", dark: "file:../../icons/hectile.dark.svg" },
    group: ["trigger"],
    version: 1,
    subtitle: '={{($parameter["events"] || []).join(", ")}}',
    description: "Starts the workflow when something happens in Hectile",
    defaults: { name: "Hectile Trigger" },
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: "hectileApi", required: true }],
    webhooks: [{ name: "default", httpMethod: "POST", responseMode: "onReceived", path: "webhook" }],
    properties: [
      {
        displayName: "Events",
        name: "events",
        type: "multiOptions",
        required: true,
        default: ["invoice.paid"],
        description: "What starts the workflow. Each message carries the record as Hectile's API answers it.",
        options: EVENTS,
      },
    ],
  };

  webhookMethods = {
    default: {
      async checkExists(this: IHookFunctions): Promise<boolean> {
        const data = this.getWorkflowStaticData("node");
        if (!data.webhookId) return false;
        const credentials = await this.getCredentials("hectileApi");
        const answer = (await this.helpers.httpRequestWithAuthentication.call(this, "hectileApi", { method: "GET", url: `${credentials.baseUrl}/webhooks`, json: true })) as {
          data: { id: string; url: string }[];
        };
        return answer.data.some((endpoint) => endpoint.id === data.webhookId && endpoint.url === this.getNodeWebhookUrl("default"));
      },
      async create(this: IHookFunctions): Promise<boolean> {
        const credentials = await this.getCredentials("hectileApi");
        const answer = (await this.helpers.httpRequestWithAuthentication.call(this, "hectileApi", {
          method: "POST",
          url: `${credentials.baseUrl}/webhooks`,
          body: { url: this.getNodeWebhookUrl("default"), events: this.getNodeParameter("events") as string[] },
          json: true,
        })) as { id: string; secret: string };
        const data = this.getWorkflowStaticData("node");
        data.webhookId = answer.id;
        data.secret = answer.secret;
        return true;
      },
      async delete(this: IHookFunctions): Promise<boolean> {
        const data = this.getWorkflowStaticData("node");
        if (!data.webhookId) {
          // Nothing was subscribed (or it was already removed): there is nothing to delete in Hectile.
          delete data.secret;
          return true;
        }
        const credentials = await this.getCredentials("hectileApi");
        try {
          await this.helpers.httpRequestWithAuthentication.call(this, "hectileApi", {
            method: "DELETE",
            url: `${credentials.baseUrl}/webhooks/${data.webhookId}`,
            json: true,
          });
        } catch (error) {
          // Deliberate: Hectile answers 404 with the error code NOT_FOUND when this subscription no longer exists (it
          // was removed in Hectile's settings, or with another key's workflow). The goal of deleting is then already
          // met, so the stored details can go. Any other failure — a refused or revoked key (401, 403), a rate limit
          // (429), a server error, a network failure or a timeout, or a 404 that isn't Hectile's NOT_FOUND — may leave
          // the subscription in place: keep its ID and secret so turning the workflow off can be retried, and report
          // the error.
          const body = failedBody(error) as { error?: { code?: unknown } } | undefined;
          const absent = failedStatus(error) === 404 && body?.error?.code === "NOT_FOUND";
          if (!absent) throw new NodeApiError(this.getNode(), error as JsonObject);
        }
        delete data.webhookId;
        delete data.secret;
        return true;
      },
    },
  };

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const request = this.getRequestObject() as unknown as { rawBody?: Buffer; body: IDataObject; headers: Record<string, string | undefined> };
    const secret = this.getWorkflowStaticData("node").secret as string | undefined;
    // "Hectile-Signature: t=<seconds>,v1=<HMAC-SHA256 of "<t>.<body>" with this subscription's secret>".
    const parts = Object.fromEntries((request.headers["hectile-signature"] ?? "").split(",").map((part) => part.trim().split("=")));
    const raw = request.rawBody ? request.rawBody.toString("utf8") : JSON.stringify(request.body);
    const expected = secret && parts.t ? createHmac("sha256", secret).update(`${parts.t}.${raw}`).digest("hex") : "";
    const fresh = Math.abs(Date.now() / 1000 - Number(parts.t)) <= 300;
    const signed = Boolean(expected) && typeof parts.v1 === "string" && expected.length === parts.v1.length && timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
    // A message that isn't from Hectile, or is more than 5 minutes old, is refused; Hectile's log shows the 401.
    if (!signed || !fresh) {
      this.getResponseObject().status(401).send("Invalid or expired Hectile-Signature");
      return { noWebhookResponse: true };
    }
    const body = request.body as { type?: string };
    if (body.type === "endpoint.ping") return { webhookResponse: "OK" };
    return { workflowData: [this.helpers.returnJsonArray([request.body])] };
  }
}
