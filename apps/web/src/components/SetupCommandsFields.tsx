// apps/web/src/components/SetupCommandsFields.tsx
// The setup commands as cards, one per command, in the order they run:
// after the packages install, as the sandbox's user, each in its own shell.
// Shared by the agent config dialogs, so a command is edited through the
// field it was written with. A card is a textarea, since a command may span
// lines (a heredoc that writes a file).
import { CloseIcon, PlusIcon } from "./Icons";
import { Field } from "./Field";
import "./CredentialsFields.css";
import "./SetupCommandsFields.css";

export function SetupCommandsFields({
  commands,
  onChange,
  disabled,
}: {
  commands: string[];
  onChange: (commands: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="field">
      <span className="field-label">
        Setup commands
        <span className="field-optional">optional</span>
      </span>

      {/* The credentials field's card list: the two lists in one dialog
          read alike (components/CredentialsFields.css). */}
      <div className="creds setup">
        {/* Keyed by position: cards are only added at the end or removed,
            and every textarea is controlled, so a card always shows its
            own command whichever node renders it. */}
        {commands.map((command, i) => (
          <section className="cred" key={i} aria-label={`Setup command ${i + 1}`}>
            <Field
              label={`Command ${i + 1}`}
              name={`setup-command-${i}`}
              value={command}
              onChange={(next) => onChange(commands.map((c, j) => (j === i ? next : c)))}
              placeholder="echo 'hello world' > ~/hello.txt"
              // Tall enough for the command it holds and a line to spare (a
              // long line wraps), so a heredoc shows whole; past eight, it
              // scrolls.
              rows={Math.min(8, command.split("\n").length + 1)}
              spellCheck={false}
              disabled={disabled}
              multiline
              required
            />
            {disabled ? null : (
              <button
                className="cred-remove"
                type="button"
                onClick={() => onChange(commands.filter((_, j) => j !== i))}
                aria-label={`Remove setup command ${i + 1}`}
              >
                <CloseIcon />
              </button>
            )}
          </section>
        ))}

        {disabled ? (
          commands.length === 0 ? (
            <p className="cred-none">None</p>
          ) : null
        ) : (
          <button className="cred-add" type="button" onClick={() => onChange([...commands, ""])}>
            <PlusIcon width={13} height={13} />
            Add command
          </button>
        )}
      </div>
    </div>
  );
}
