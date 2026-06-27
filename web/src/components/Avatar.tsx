// A pixel avatar: a single Press Start 2P letter in a bordered white box.
// Used at 32px (sidebar), 30px (chat), and 26px (tab strip).

interface AvatarProps {
  letter: string;
  size?: number;
  fontSize?: number;
}

export function Avatar({ letter, size = 32, fontSize = 12 }: AvatarProps) {
  return (
    <div className="avatar" style={{ width: size, height: size, fontSize }}>
      {letter}
    </div>
  );
}
