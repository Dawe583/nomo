import { useEffect, useRef, useContext, useState } from "react";
import type { Command } from "./commands.ts";
import * as m from "motion/react-m";
import { MotionEnabled, useText } from "./ui.tsx";
import { filterPaletteRecentFirst } from "./commands.ts";

export function CommandMenu({
  items,
  active,
  choose,
  loading,
  error,
  retry,
  scope,
  recentIds,
}: {
  items: Command[];
  active: number;
  choose: (command: Command) => void;
  loading: boolean;
  error: boolean;
  retry: () => void;
  scope?: string;
  recentIds?: string[];
}) {
  const t = useText();
  const animate = useContext(MotionEnabled);
  const selected = useRef<HTMLButtonElement>(null);
  const [filtered, setFiltered] = useState(() =>
    filterPaletteRecentFirst(items, "", recentIds),
  );
  useEffect(() => {
    setFiltered(filterPaletteRecentFirst(items, "", recentIds));
  }, [items, recentIds]);
  useEffect(() => {
    selected.current?.scrollIntoView({ block: "nearest" });
  }, [active, items[active]?.id]);
  return (
    <m.section
      initial={animate ? { opacity: 0, y: 6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: animate ? 0.14 : 0 }}
      className="command-palette"
      aria-label={t("Příkazy a nástroje VOID", "VOID commands and tools")}
    >
      <header>
        <span>
          ╱ VOID <strong>{t("Příkazy a nástroje", "Commands & tools")}</strong>
        </span>
        <small>↑ ↓ · Enter · Esc</small>
      </header>
      <div
        className="command-results"
        role="listbox"
        id="void-command-list"
        aria-label={t("Dostupné příkazy", "Available commands")}
      >
        {filtered.map((item, index) => (
          <button
            key={item.id}
            id={`void-command-${index}`}
            ref={index === active ? selected : undefined}
            type="button"
            role="option"
            aria-selected={index === active}
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => choose(item)}
          >
            <span className="command-glyph">{item.tool ? "⌘" : "/"}</span>
            <span className="command-copy">
              <strong>/{item.name}</strong>
              <span>{item.description}</span>
            </span>
            <small>
              {item.tool
                ? item.capturedUndo
                  ? t("r1 · Zpět", "r1 · Undo")
                  : item.klass === "r0"
                    ? t("r0 · Čtení", "r0 · Read")
                    : t("Dle policy", "Policy")
                : "VOID"}
            </small>
          </button>
        ))}
      </div>
      {!items.length && (
        <p role="status">
          {t("Žádné odpovídající příkazy.", "No matching commands.")}
        </p>
      )}
      {loading && (
        <p role="status">{t("Načítám nástroje…", "Loading tools…")}</p>
      )}
      {error && (
        <p role="alert">
          {t("Nástroje se nepodařilo načíst.", "Could not load tools.")}{" "}
          <button type="button" onClick={retry}>
            {t("Zkusit znovu", "Retry")}
          </button>
        </p>
      )}
      <footer>
        {scope === "session"
          ? t(
              "Nástroje této konverzace. Výběr připraví požadavek, nic nespustí.",
              "This conversation’s tools. Selection prepares a request; it runs nothing.",
            )
          : t(
              "Konfigurované nástroje. Kompletní snapshot se načte po zahájení konverzace.",
              "Configured tools. The complete snapshot loads after a conversation starts.",
            )}
      </footer>
    </m.section>
  );
}
