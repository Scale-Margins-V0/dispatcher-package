import { describe, expect, it, vi, beforeEach } from "vitest";

const sendMock = vi.hoisted(() => vi.fn().mockResolvedValue([{ statusCode: 202, headers: {} }]));

vi.mock("@sendgrid/mail", () => ({
  setApiKey: vi.fn(),
  send: sendMock,
  default: { setApiKey: vi.fn(), send: sendMock },
}));

describe("SendGridProvider", () => {
  beforeEach(() => {
    sendMock.mockClear();
    process.env.SENDGRID_API_KEY = "SG.test";
  });

  it("passes customArgs when message.context is set", async () => {
    const { SendGridProvider } = await import("./sendgrid.js");
    const p = new SendGridProvider("SG.test");
    await p.send({
      to: "to@example.com",
      from: "from@example.com",
      subject: "s",
      html: "<p/>",
      context: {
        campaign_id: "c1",
        user_id: "u1",
        organization_id: "o1",
        analytics_callback_url: "http://127.0.0.1:9/api/webhooks/campaign-analytics/x",
      },
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    const arg = sendMock.mock.calls[0]![0] as {
      customArgs?: Record<string, string>;
      tracking_settings?: { open_tracking?: { enable?: boolean; substitution_tag?: string } };
      html?: string;
    };
    expect(arg.customArgs?.campaign_id).toBe("c1");
    expect(arg.customArgs?.user_id).toBe("u1");
    expect(arg.tracking_settings?.open_tracking?.enable).toBe(true);
    expect(arg.tracking_settings?.open_tracking?.substitution_tag).toBe("%open-track%");
    expect(arg.html).toContain("%open-track%");
  });
});
