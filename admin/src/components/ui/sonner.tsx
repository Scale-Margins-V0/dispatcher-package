import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * shadcn's stock wrapper reads the theme from next-themes. This app owns its
 * own theme state (light | dark | system, persisted and reflected on
 * <html data-theme>), so App passes `theme` in instead. Colours come from this
 * app's CSS variables rather than shadcn's raw --popover/--radius tokens, which
 * we intentionally never define at :root (see styles.css).
 */
const Toaster = ({ ...props }: ToasterProps) => (
  <Sonner
    className="toaster group"
    position="bottom-right"
    richColors
    closeButton
    icons={{
      success: <CircleCheckIcon className="size-4" />,
      info: <InfoIcon className="size-4" />,
      warning: <TriangleAlertIcon className="size-4" />,
      error: <OctagonXIcon className="size-4" />,
      loading: <Loader2Icon className="size-4 animate-spin" />,
    }}
    style={
      {
        "--normal-bg": "var(--surface)",
        "--normal-text": "var(--text)",
        "--normal-border": "var(--border)",
        "--border-radius": "var(--radius-sm)",
      } as React.CSSProperties
    }
    {...props}
  />
);

export { Toaster };
