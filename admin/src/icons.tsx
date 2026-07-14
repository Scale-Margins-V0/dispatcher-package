import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;
const Icon = ({ children, ...props }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    {children}
  </svg>
);

export const GridIcon = (props: IconProps) => <Icon {...props}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></Icon>;
export const ServerIcon = (props: IconProps) => <Icon {...props}><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/></Icon>;
export const SlidersIcon = (props: IconProps) => <Icon {...props}><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></Icon>;
export const ActivityIcon = (props: IconProps) => <Icon {...props}><path d="M3 12h4l2-7 4 14 2-7h6"/></Icon>;
export const RefreshIcon = (props: IconProps) => <Icon {...props}><path d="M20 6v5h-5M4 18v-5h5"/><path d="M18.5 9A7 7 0 0 0 6.2 6.2L4 8M5.5 15A7 7 0 0 0 17.8 17.8L20 16"/></Icon>;
export const SunIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.41M17.66 6.34l1.41-1.41"/></Icon>;
export const MoonIcon = (props: IconProps) => <Icon {...props}><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/></Icon>;
export const MonitorIcon = (props: IconProps) => <Icon {...props}><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></Icon>;
export const ShieldIcon = (props: IconProps) => <Icon {...props}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></Icon>;
export const BoxIcon = (props: IconProps) => <Icon {...props}><path d="m21 8-9 5-9-5 9-5 9 5Z"/><path d="m3 8 9 5 9-5M3 12l9 5 9-5M3 16l9 5 9-5"/></Icon>;
export const ClockIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></Icon>;
export const CheckIcon = (props: IconProps) => <Icon {...props}><path d="m5 12 4 4L19 6"/></Icon>;
export const AlertIcon = (props: IconProps) => <Icon {...props}><path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></Icon>;
export const UsersIcon = (props: IconProps) => <Icon {...props}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></Icon>;
export const CopyIcon = (props: IconProps) => <Icon {...props}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></Icon>;
export const ChevronIcon = (props: IconProps) => <Icon {...props}><path d="m6 9 6 6 6-6"/></Icon>;
export const MessageIcon = (props: IconProps) => <Icon {...props}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/></Icon>;
export const BellIcon = (props: IconProps) => <Icon {...props}><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></Icon>;
export const MailIcon = (props: IconProps) => <Icon {...props}><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></Icon>;
export const ChatIcon = (props: IconProps) => <Icon {...props}><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></Icon>;
