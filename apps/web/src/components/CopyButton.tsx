import { Check, Copy } from "lucide-react";
import { useState } from "react";

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <button className="button button-secondary button-small" type="button" onClick={copy}>
      {copied ? <Check size={15} /> : <Copy size={15} />}
      {copied ? "Copied" : label}
    </button>
  );
}

