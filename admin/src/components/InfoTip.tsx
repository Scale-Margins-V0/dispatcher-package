import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HelpIcon } from "../icons";

export function InfoTip({ label }: { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="info-tip-trigger" tabIndex={0} role="button" aria-label={label}>
          <HelpIcon />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" align="center">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
