import { createHmac, timingSafeEqual } from "crypto";
import { NodeConnectionTypes, type IDataObject, type IHookFunctions, type INodeType, type INodeTypeDescription, type IWebhookFunctions, type IWebhookResponseData } from "n8n-workflow";

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
        if (data.webhookId) {
          const credentials = await this.getCredentials("hectileApi");
          await this.helpers.httpRequestWithAuthentication
            .call(this, "hectileApi", { method: "DELETE", url: `${credentials.baseUrl}/webhooks/${data.webhookId}`, json: true })
            .catch(() => undefined);
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
