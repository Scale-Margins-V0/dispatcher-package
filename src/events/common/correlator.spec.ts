import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  explainSendGridCorrelationDrop,
  extractCorrelationFromGupshupEvent,
  extractCorrelationFromSendGridEvent,
  extractCorrelationFromSesMail,
  LookupTableCorrelator,
} from "./correlator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadSendGrid(name: string): unknown {
  const p = join(__dirname, "..", "__fixtures__", "sendgrid", `${name}.json`);
  return JSON.parse(readFileSync(p, "utf-8")) as unknown;
}

describe("correlator", () => {
  it("extracts from SendGrid custom_args", () => {
    const c = extractCorrelationFromSendGridEvent(loadSendGrid("delivered"));
    expect(c).toEqual({
      campaign_id: "c_test_1",
      user_id: "u_42",
      organization_id: "org_1",
      analytics_callback_url: "http://127.0.0.1:19999/api/webhooks/campaign-analytics/test",
    });
  });

  it("returns null when SendGrid custom_args missing", () => {
    expect(extractCorrelationFromSendGridEvent(loadSendGrid("missing-correlation"))).toBeNull();
  });

  it("explainSendGridCorrelationDrop mentions Test Integration when no custom_args", () => {
    const msg = explainSendGridCorrelationDrop(loadSendGrid("missing-correlation"));
    expect(msg).toMatch(/Test Integration|custom_args/i);
  });

  it("extracts from SES mail.tags", () => {
    const mail = {
      tags: {
        campaign_id: ["c_test_1"],
        user_id: ["u_42"],
        organization_id: ["org_1"],
      },
    };
    expect(extractCorrelationFromSesMail(mail)).toEqual({
      campaign_id: "c_test_1",
      user_id: "u_42",
      organization_id: "org_1",
    });
  });

  it("extracts from Gupshup tag JSON string", () => {
    const body = JSON.parse(
      readFileSync(join(__dirname, "..", "__fixtures__", "gupshup", "delivered.json"), "utf-8")
    ) as unknown;
    const c = extractCorrelationFromGupshupEvent(body);
    expect(c?.campaign_id).toBe("c_test_1");
    expect(c?.user_id).toBe("u_42");
  });

  it("extracts from Gupshup v2 envelope payload.tag", () => {
    const body = JSON.parse(
      readFileSync(join(__dirname, "..", "__fixtures__", "gupshup", "v2-enqueued.json"), "utf-8")
    ) as unknown;
    const c = extractCorrelationFromGupshupEvent(body);
    expect(c?.campaign_id).toBe("c_v2");
    expect(c?.user_id).toBe("u_v2");
  });

  it("LookupTableCorrelator stub returns null", () => {
    const lt = new LookupTableCorrelator();
    expect(lt.lookup("any")).toBeNull();
  });
});
