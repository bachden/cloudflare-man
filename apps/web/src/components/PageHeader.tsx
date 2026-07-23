import type { ReactNode } from "react";

export function PageHeader({ title, eyebrow, actions }: { title: string; eyebrow?: string; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h1>{title}</h1></div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

