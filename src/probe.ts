import type { ConnectorCatalogProbe } from "@regenic/connector-contract";
import { DingTalkOpenApi } from "./dingtalk-openapi";

export async function probeDingTalkCatalog(input: {
  env: NodeJS.ProcessEnv;
}): Promise<ConnectorCatalogProbe> {
  const clientId = input.env.DINGTALK_CLIENT_ID?.trim();
  const clientSecret = input.env.DINGTALK_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return {
      services: {
        "dingtalk-app": {
          ready: false,
          hint: "probe.missing",
        },
      },
    };
  }
  try {
    await new DingTalkOpenApi({
      client_id: clientId,
      client_secret: clientSecret,
      robot_code: clientId,
    }).accessToken();
    return {
      services: {
        "dingtalk-app": {
          ready: true,
          hint: "probe.ready",
        },
      },
    };
  } catch {
    return {
      services: {
        "dingtalk-app": {
          ready: false,
          hint: "probe.rejected",
        },
      },
    };
  }
}
