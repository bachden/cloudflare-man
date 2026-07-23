import { Check, Copy } from "lucide-react";
import { useState } from "react";

export function CopyButton({ value, label = "Copy", iconOnly = false }: { value: string; label?: string; iconOnly?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button className={iconOnly ? "copy-icon" : "button button-secondary button-small"} type="button" onClick={copy} title={iconOnly ? (copied ? "Copied" : label) : undefined} aria-label={iconOnly ? (copied ? "Copied" : label) : undefined}>
      {copied ? <Check size={15} /> : <Copy size={15} />}
      {!iconOnly && (copied ? "Copied" : label)}
    </button>
  );
}
