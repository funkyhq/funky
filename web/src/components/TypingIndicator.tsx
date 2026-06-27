// The assistant "typing" bubble: three blue squares blinking in sequence.

import { Avatar } from "./Avatar";

export function TypingIndicator({ letter }: { letter: string }) {
  return (
    <div className="msg msg-agent">
      <Avatar letter={letter} size={30} fontSize={11} />
      <div className="typing" aria-label="Agent is typing">
        <span className="typing-dot" />
        <span className="typing-dot" />
        <span className="typing-dot" />
      </div>
    </div>
  );
}
