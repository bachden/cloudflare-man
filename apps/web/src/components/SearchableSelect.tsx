import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

export type SearchableSelectOption = {
  value: string;
  label: string;
};

export function SearchableSelect({
  name,
  options,
  defaultValue = "",
  ariaLabel,
  emptyMessage = "No matching options",
  onValueChange
}: {
  name: string;
  options: SearchableSelectOption[];
  defaultValue?: string;
  ariaLabel: string;
  emptyMessage?: string;
  onValueChange?: (value: string) => void;
}) {
  const initial = options.find((option) => option.value === defaultValue) ?? options[0];
  const [selectedValue, setSelectedValue] = useState(initial?.value ?? "");
  const [query, setQuery] = useState(initial?.label ?? "");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const filteredOptions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized || options.some((option) => option.value === selectedValue && option.label === query)) return options;
    return options.filter((option) => option.label.toLowerCase().includes(normalized));
  }, [options, query, selectedValue]);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        const selected = options.find((option) => option.value === selectedValue) ?? options[0];
        setQuery(selected?.label ?? "");
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [options, selectedValue]);

  const select = (option: SearchableSelectOption) => {
    setSelectedValue(option.value);
    onValueChange?.(option.value);
    setQuery(option.label);
    setOpen(false);
  };

  return (
    <div
      className="searchable-select"
      ref={rootRef}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          const selected = options.find((option) => option.value === selectedValue) ?? options[0];
          setQuery(selected?.label ?? "");
          setOpen(false);
        }
      }}
    >
      <input type="hidden" name={name} value={selectedValue} />
      <div className="searchable-select-control">
        <input
          value={query}
          role="combobox"
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && filteredOptions[activeIndex] ? `${listId}-${activeIndex}` : undefined}
          onFocus={() => {
            setOpen(true);
            setActiveIndex(0);
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedValue("");
            onValueChange?.("");
            setOpen(true);
            setActiveIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((index) => Math.min(index + 1, Math.max(filteredOptions.length - 1, 0)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter" && open) {
              event.preventDefault();
              if (filteredOptions[activeIndex]) select(filteredOptions[activeIndex]);
            } else if (event.key === "Escape") {
              const selected = options.find((option) => option.value === selectedValue) ?? options[0];
              setQuery(selected?.label ?? "");
              setOpen(false);
            }
          }}
        />
        <button type="button" aria-label={open ? "Close options" : "Open options"} onClick={() => setOpen((value) => !value)}>
          <ChevronDown size={16} />
        </button>
      </div>
      {open && (
        <div className="searchable-select-menu" id={listId} role="listbox">
          {filteredOptions.length === 0 ? (
            <div className="searchable-select-empty">{emptyMessage}</div>
          ) : filteredOptions.map((option, index) => (
            <button
              id={`${listId}-${index}`}
              type="button"
              role="option"
              aria-selected={option.value === selectedValue}
              className={index === activeIndex ? "active" : ""}
              key={`${option.value}-${option.label}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => select(option)}
            >
              <span>{option.label}</span>
              {option.value === selectedValue && <Check size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
