// apps/web/src/components/PackagesFields.tsx
// The packages as groups, one per package manager: each group's specs as
// removable chips and an Add that opens an input in place, then a row that
// starts a group for each manager not yet used. Shared by the agent config
// dialogs and the quickstart, so packages are written the same way wherever
// they are written.
//
// Only the managers the sandbox provider installs can be added (see
// MANAGERS). A stored config can still carry another — written through the
// api — and its group is shown with its chips removable but nothing to add.
import { type KeyboardEvent, useState } from "react";
import type { Packages } from "../lib/api";
import { addSpec, MANAGERS, managerOf, removeSpec } from "../lib/packages";
import { CloseIcon, PlusIcon } from "./Icons";
import "./PackagesFields.css";

export function PackagesFields({
  packages,
  onChange,
  disabled,
}: {
  packages: Packages;
  onChange: (packages: Packages) => void;
  disabled?: boolean;
}) {
  /** The group whose input is open, and what has been typed into it. */
  const [adding, setAdding] = useState<{ manager: string; text: string }>();

  // A group shows while it has specs, or while its input is open — so a
  // group just started is there to type into, and one emptied goes away.
  // In the form's own order, whatever order the api stored them in; a
  // manager the form doesn't offer comes last.
  const shown = (manager: string) =>
    (packages[manager]?.length ?? 0) > 0 || adding?.manager === manager;
  const groups = [
    ...MANAGERS.map((manager) => manager.id).filter(shown),
    ...Object.keys(packages).filter((manager) => !managerOf(manager) && shown(manager)),
  ];
  const unused = MANAGERS.filter((manager) => !groups.includes(manager.id));

  /** Adds what was typed and, unless asked to stay, closes the input. */
  function commit(keepOpen: boolean) {
    if (!adding) return;
    if (adding.text.trim() !== "") onChange(addSpec(packages, adding.manager, adding.text));
    setAdding(keepOpen ? { manager: adding.manager, text: "" } : undefined);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      // The field sits inside a form: Enter adds here, it doesn't submit.
      event.preventDefault();
      commit(true);
    } else if (event.key === "Escape") {
      // Closes the input, not the dialog around it.
      event.preventDefault();
      event.stopPropagation();
      setAdding(undefined);
    }
  }

  return (
    <div className="field">
      <span className="field-label">
        Packages
        <span className="field-optional">optional</span>
      </span>

      <div className="pkgs">
        {groups.map((id) => {
          const manager = managerOf(id);
          const specs = packages[id] ?? [];
          const open = adding?.manager === id;
          return (
            <section className="pkg-group" key={id} aria-label={manager?.label ?? id}>
              <header className="pkg-head">
                <span className="pkg-title">{manager?.label ?? id}</span>
                {manager ? <span className="pkg-registry">{manager.registry}</span> : null}
                <span className="pkg-count">{specs.length}</span>
                {manager && !disabled ? (
                  <button
                    className="pkg-add"
                    type="button"
                    onClick={() => setAdding({ manager: id, text: "" })}
                  >
                    <PlusIcon width={13} height={13} />
                    Add
                  </button>
                ) : null}
              </header>

              {specs.length > 0 || open ? (
                <ul className="pkg-chips">
                  {specs.map((spec) => (
                    <li className="pkg-chip" key={spec}>
                      <span className="pkg-spec">{spec}</span>
                      {disabled ? null : (
                        <button
                          className="pkg-remove"
                          type="button"
                          onClick={() => onChange(removeSpec(packages, id, spec))}
                          aria-label={`Remove ${spec}`}
                        >
                          <CloseIcon />
                        </button>
                      )}
                    </li>
                  ))}
                  {open ? (
                    <li>
                      <input
                        className="pkg-input"
                        value={adding.text}
                        onChange={(event) => setAdding({ manager: id, text: event.target.value })}
                        onKeyDown={onKeyDown}
                        onBlur={() => commit(false)}
                        placeholder={manager?.example}
                        aria-label={`Add ${manager?.label ?? id}`}
                        // Opened by a click on Add, so focus follows it there.
                        autoFocus
                      />
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </section>
          );
        })}

        {unused.length > 0 && !disabled ? (
          <div className="pkg-more">
            {unused.map((manager) => (
              <button
                className="pkg-more-btn"
                type="button"
                key={manager.id}
                onClick={() => setAdding({ manager: manager.id, text: "" })}
              >
                <PlusIcon width={13} height={13} />
                {manager.short}
                <span className="pkg-registry">{manager.id}</span>
              </button>
            ))}
          </div>
        ) : null}

        {groups.length === 0 && disabled ? <p className="pkg-none">None</p> : null}
      </div>
    </div>
  );
}
