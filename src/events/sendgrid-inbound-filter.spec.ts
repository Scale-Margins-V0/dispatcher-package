import { describe, expect, it } from "vitest";
import {
  DEFAULT_SENDGRID_INBOUND_WIRE_EVENTS,
  sendGridInboundWireAllowed,
} from "./sendgrid-inbound-filter.js";

describe("sendGridInboundWireAllowed", () => {
  it("default list includes delivered and processed, excludes open", () => {
    expect(DEFAULT_SENDGRID_INBOUND_WIRE_EVENTS).toContain("delivered");
    expect(DEFAULT_SENDGRID_INBOUND_WIRE_EVENTS).toContain("processed");
    expect(DEFAULT_SENDGRID_INBOUND_WIRE_EVENTS).not.toContain("open");
    expect(sendGridInboundWireAllowed({ event: "delivered" }, undefined)).toBe(true);
    expect(sendGridInboundWireAllowed({ event: "open" }, undefined)).toBe(false);
  });

  it("empty config uses defaults", () => {
    expect(sendGridInboundWireAllowed({ event: "delivered" }, [])).toBe(true);
    expect(sendGridInboundWireAllowed({ event: "click" }, [])).toBe(false);
  });

  it("* allows any mapped wire", () => {
    expect(sendGridInboundWireAllowed({ event: "open" }, ["*"])).toBe(true);
    expect(sendGridInboundWireAllowed({ event: "unknown_sg_type_xyz" }, ["*"])).toBe(false);
  });

  it("explicit list is respected", () => {
    expect(sendGridInboundWireAllowed({ event: "open" }, ["open", "click"])).toBe(true);
    expect(sendGridInboundWireAllowed({ event: "delivered" }, ["open"])).toBe(false);
  });
});
