import { describe, expect, it, vi, beforeEach } from "vitest";

const sendMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ MessageId: "ses-msg-1" })
);

vi.mock("@aws-sdk/client-ses", () => ({
  SESClient: class {
    send = sendMock;
  },
  SendEmailCommand: class {
    Tags?: { Name: string; Value: string }[];
    ConfigurationSetName?: string;
    constructor(input: Record<string, unknown>) {
      Object.assign(this, input);
    }
  },
}));

describe("SESProvider", () => {
  beforeEach(() => {
    sendMock.mockClear();
    process.env.SES_EVENT_CONFIG_SET = "test-config-set";
  });

  it("includes Tags when context is set", async () => {
    const { SESProvider } = await import("./ses.js");
    const p = new SESProvider("us-east-1");
    await p.send({
      to: "to@example.com",
      from: "from@example.com",
      subject: "s",
      html: "<p/>",
      context: {
        campaign_id: "c1",
        user_id: "u1",
        organization_id: "o1",
        analytics_callback_url: "http://x",
      },
    });
    expect(sendMock).toHaveBeenCalled();
    const cmd = sendMock.mock.calls[0]![0] as { Tags?: { Name: string; Value: string }[] };
    expect(cmd.Tags?.some((t) => t.Name === "campaign_id")).toBe(true);
  });
});
