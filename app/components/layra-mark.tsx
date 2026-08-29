export type LayraMarkVariant = "loop" | "fold" | "stitch" | "frame";

export function LayraMark({ variant = "frame", className = "" }: { variant?: LayraMarkVariant; className?: string }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2.2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  return <svg className={`layra-mark ${className}`} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    {variant === "loop" && <>
      <path {...common} d="M15 10v24.5c0 2.3 1.2 3.5 3.6 3.5H32" />
      <path {...common} d="M16 28.5c6.2-13.7 12.6-18.8 18.7-15.3 6.2 3.5 2.8 13.3-10.1 29.3" />
      <circle cx="34.7" cy="13.2" r="2.2" fill="currentColor" />
    </>}
    {variant === "fold" && <>
      <path {...common} d="m10.5 35.5 13.8-25 13.2 25" />
      <path {...common} d="M14.8 28h19.1M24.3 10.5V39" />
      <path {...common} d="m17.5 16.8 6.8 4.4 6.8-4.4" />
    </>}
    {variant === "stitch" && <>
      <path {...common} d="M12 10v28h14" />
      <path {...common} d="m21 38 10.8-28L41 38" />
      <path {...common} strokeDasharray="2.7 4.2" d="M17 30c4.8-1.4 8.6-5 11.3-10.8" />
      <circle cx="32" cy="10" r="2" fill="currentColor" />
    </>}
    {variant === "frame" && <>
      <rect {...common} x="8.5" y="8.5" width="31" height="31" rx="9" />
      <path {...common} d="M17 15v18h11M30.7 15 24 33M30.7 15 37 33M27.5 25h6.2" />
    </>}
  </svg>;
}
