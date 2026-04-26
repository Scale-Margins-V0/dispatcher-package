import { describe, expectTypeOf, it } from "vitest";
import type { AnalyticsEventType } from "../../providers/types.js";
import type {
  Channel,
  Correlation,
  InboundEventAdapter,
  InboundProviderName,
  StandardizedEvent,
} from "./types.js";

describe("events/common/types", () => {
  it("StandardizedEvent narrows channel and provider", () => {
    expectTypeOf<StandardizedEvent["channel"]>().toEqualTypeOf<Channel>();
    expectTypeOf<StandardizedEvent["provider"]>().toEqualTypeOf<InboundProviderName>();
    expectTypeOf<StandardizedEvent["event"]>().toEqualTypeOf<AnalyticsEventType>();
  });

  it("Correlation carries campaign + user + org", () => {
    expectTypeOf<Correlation["campaign_id"]>().toEqualTypeOf<string>();
    expectTypeOf<Correlation["user_id"]>().toEqualTypeOf<string>();
    expectTypeOf<Correlation["organization_id"]>().toEqualTypeOf<string>();
  });

  it("InboundEventAdapter is implementable for a new provider", () => {
    expectTypeOf<InboundEventAdapter>().toMatchTypeOf<{
      name: InboundProviderName;
      channel: Channel;
      verifySignature: (req: import("./types.js").SignatureRequest) => boolean | Promise<boolean>;
      parseEvents: (rawBody: Buffer) => unknown[];
      extractCorrelation: (event: unknown) => Correlation | null;
      stripPii: (event: unknown) => Record<string, unknown>;
      toStandardEvent: (
        stripped: Record<string, unknown>,
        c: Correlation
      ) => StandardizedEvent | null;
    }>();
  });
});
