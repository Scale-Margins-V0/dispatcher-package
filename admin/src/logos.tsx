/**
 * Inline provider logos (SVG, so they render under the strict admin CSP where
 * external <img> is blocked). Brand-colored app-icon marks — recognizable
 * accents next to the provider name, not pixel-exact trademark artwork.
 */

function SendGridLogo() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" className="provider-logo" aria-hidden="true">
      <rect width="24" height="24" rx="5" fill="#F0F6FE" />
      <path d="M12 4 20 12 12 12Z" fill="#1A82E2" />
      <path d="M12 4 4 12 12 12Z" fill="#9AC7F2" />
      <path d="M12 20 4 12 12 12Z" fill="#1A82E2" />
      <path d="M12 20 20 12 12 12Z" fill="#9AC7F2" />
    </svg>
  );
}

function SesLogo() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" className="provider-logo" aria-hidden="true">
      <rect width="24" height="24" rx="5" fill="#232F3E" />
      <text
        x="12"
        y="12.4"
        textAnchor="middle"
        fontFamily="Arial, sans-serif"
        fontSize="7.5"
        fontWeight="700"
        fill="#ffffff"
      >
        aws
      </text>
      <path
        d="M6.6 15.8c3.3 1.9 7.5 1.9 10.8 0"
        stroke="#FF9900"
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
      />
      <path d="M15.7 16.7l2-.6-.6 2Z" fill="#FF9900" />
    </svg>
  );
}

function GupshupLogo() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" className="provider-logo" aria-hidden="true">
      <rect width="24" height="24" rx="5" fill="#FA4616" />
      <path
        d="M6 8.6A2.6 2.6 0 0 1 8.6 6h6.8A2.6 2.6 0 0 1 18 8.6v2.8a2.6 2.6 0 0 1-2.6 2.6H11l-3.6 3.1v-3.1h-.8A2.6 2.6 0 0 1 6 11.4Z"
        fill="#ffffff"
      />
    </svg>
  );
}

export function ProviderLogo({ provider }: { provider: string }) {
  switch (provider.toLowerCase()) {
    case "sendgrid":
      return <SendGridLogo />;
    case "ses":
      return <SesLogo />;
    case "gupshup":
      return <GupshupLogo />;
    default:
      return (
        <span className="provider-logo provider-logo-fallback" aria-hidden="true">
          {provider.charAt(0).toUpperCase()}
        </span>
      );
  }
}

/** Official docs for obtaining each provider's credentials. */
export const PROVIDER_DOCS: Record<string, { url: string; label: string }> = {
  sendgrid: {
    url: "https://www.twilio.com/docs/sendgrid/ui/account-and-settings/api-keys",
    label: "Create a SendGrid API key",
  },
  ses: {
    url: "https://docs.aws.amazon.com/ses/latest/dg/send-email-set-up.html",
    label: "Set up AWS SES access keys & region",
  },
  gupshup: {
    url: "https://docs.gupshup.io/docs/whatsapp-api-overview",
    label: "Get Gupshup WhatsApp API credentials",
  },
};
