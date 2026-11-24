import { useId, useMemo, useState } from "react";
import { Chip, Input } from "../ui";

export interface Option {
  id: string;
  name: string;
  color?: string;
}

/**
 * Autocomplete multi-picker: pick existing options or type a new name and press Enter to create it.
 */
export function Picker({
  options,
  selected,
  onAdd,
  onRemove,
  placeholder,
  label,
}: {
  options: Option[];
  selected: Option[];
  onAdd: (o: Option | { id: null; name: string }) => void;
  onRemove: (o: Option) => void;
  placeholder: string;
  label: string;
}) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const chosen = new Set(selected.map((s) => s.id));
  const matches = useMemo(
    () => options.filter((o) => !chosen.has(o.id) && o.name.toLowerCase().includes(q.toLowerCase())).slice(0, 8),
    [options, q, selected],
  );
  const exact = options.find((o) => o.name.toLowerCase() === q.trim().toLowerCase());

  function pick(i: number) {
    const m = matches[i];
    if (m) onAdd(m);
    else if (q.trim()) onAdd(exact ?? { id: null, name: q.trim() });
    setQ("");
    setActive(0);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {selected.map((s) => (
          <Chip key={s.id} color={s.color} onRemove={() => onRemove(s)}>
            {s.name}
          </Chip>
        ))}
      </div>
      <div className="relative">
        <Input
          aria-label={label}
          role="combobox"
          aria-expanded={!!q && matches.length > 0}
          aria-controls={listId}
          value={q}
          placeholder={placeholder}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              pick(active);
            } else if (e.key === "ArrowDown") setActive(Math.min(active + 1, matches.length - 1));
            else if (e.key === "ArrowUp") setActive(Math.max(active - 1, 0));
          }}
        />
        {q && (
          <ul id={listId} role="listbox" className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl">
            {matches.map((m, i) => (
              <li
                key={m.id}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(i);
                }}
                className={`cursor-pointer px-3 py-2 text-sm ${i === active ? "bg-zinc-800" : ""}`}
              >
                {m.name}
              </li>
            ))}
            {!exact && (
              <li
                role="option"
                aria-selected={matches.length === 0}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onAdd({ id: null, name: q.trim() });
                  setQ("");
                }}
                className="cursor-pointer px-3 py-2 text-sm text-accent"
              >
                + Create “{q.trim()}”
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
