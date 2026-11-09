import type { IAuthenticateGeneric, Icon, ICredentialTestRequest, ICredentialType, INodeProperties } from "n8n-workflow";

/** An API key from Hectile → Settings → Developers (Hectile Business), sent as a Bearer token. */
export class HectileApi implements ICredentialType {
  name = "hectileApi";

  displayName = "Hectile API";

  icon: Icon = { light: "file:../icons/hectile.svg", dark: "file:../icons/hectile.dark.svg" };

  documentationUrl = "https://hectile.com/help/api-keys";

  properties: INodeProperties[] = [
    {
      displayName: "API Key",
      name: "apiKey",
      type: "string",
      typeOptions: { password: true },
      default: "",
      required: true,
      description: "In Hectile, open Settings → Developers → Create API Key (Hectile Business, Owner or Admin) and give it what your workflows use",
    },
    {
      displayName: "API Address",
      name: "baseUrl",
      type: "string",
      default: "https://hectile.com/api/v1",
      description: "Hectile's API, version 1. Leave it as it is unless Hectile gives you another address.",
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: "generic",
    properties: { headers: { Authorization: "=Bearer {{$credentials.apiKey}}" } },
  };

  // GET /me answers the key's name, what it may do and its Organization.
  test: ICredentialTestRequest = {
    request: { baseURL: "={{$credentials.baseUrl}}", url: "/me", method: "GET" },
  };
}
