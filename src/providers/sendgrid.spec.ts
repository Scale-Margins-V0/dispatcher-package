import { describe, expect, it, vi, beforeEach } from "vitest";

const sendMock = vi.hoisted(() => vi.fn().mockResolvedValue([{ statusCode: 202, headers: {} }]));

class MockMailService {
  setApiKey = vi.fn();
  send = sendMock;
}

vi.mock("@sendgrid/mail", () => ({
  MailService: MockMailService,
  setApiKey: vi.fn(),
  send: sendMock,
  default: { MailService: MockMailService, setApiKey: vi.fn(), send: sendMock },
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

  /**
   * A real 403 from SendGrid — the shape that reached production and reduced a
   * fixable sender-verification problem to the single word "Forbidden".
   */
  function responseError(code: number, statusText: string, errors: unknown[]): Error {
    const error = new Error(statusText) as Error & Record<string, unknown>;
    error.code = code;
    error.response = { body: { errors } };
    return error;
  }

  it("surfaces the reason SendGrid put in the response body, not just the status text", async () => {
    const { describeSendGridError } = await import("./sendgrid.js");

    const message = describeSendGridError(
      responseError(403, "Forbidden", [
        {
          message:
            "The from address does not match a verified Sender Identity. Mail cannot be sent until this error is resolved.",
          field: "from",
          help: "https://sendgrid.com/docs/for-developers/sending-email/sender-identity/",
        },
      ])
    );

    expect(message).toContain("403 Forbidden");
    expect(message).toContain("verified Sender Identity");
    expect(message).toContain("(field: from)");
  });

  it("joins multiple body errors", async () => {
    const { describeSendGridError } = await import("./sendgrid.js");
    const message = describeSendGridError(
      responseError(400, "Bad Request", [
        { message: "The subject is required", field: "subject" },
        { message: "The content value must be a string", field: "content.0.value" },
      ])
    );
    expect(message).toContain("The subject is required");
    expect(message).toContain("The content value must be a string");
  });

  it("degrades to the status text when there is no body", async () => {
    const { describeSendGridError } = await import("./sendgrid.js");
    expect(describeSendGridError(new Error("socket hang up"))).toBe("socket hang up");
    expect(describeSendGridError("not an error")).toBe("SendGrid send failed");
  });

  it("bounds the message so it cannot overflow the log column", async () => {
    const { describeSendGridError } = await import("./sendgrid.js");
    const message = describeSendGridError(
      responseError(400, "Bad Request", [{ message: "x".repeat(5000), field: null }])
    );
    expect(message.length).toBeLessThanOrEqual(1000);
  });

  it("reports the provider error through send()", async () => {
    const { SendGridProvider } = await import("./sendgrid.js");
    sendMock.mockRejectedValueOnce(
      responseError(403, "Forbidden", [
        { message: "The from address does not match a verified Sender Identity.", field: "from" },
      ])
    );

    const result = await new SendGridProvider("SG.test").send({
      to: "to@example.com",
      from: "noreply@example.com",
      subject: "s",
      html: "<p/>",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("403 Forbidden");
    expect(result.error).toContain("verified Sender Identity");
  });
});
