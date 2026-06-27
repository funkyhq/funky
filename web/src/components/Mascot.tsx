// The Funky mascot: a pixel robot head built from positioned blocks, gently
// floating. Positions mirror the design reference exactly.

export function Mascot() {
  return (
    <div className="mascot" aria-hidden="true">
      <div className="mascot-antenna-stalk" />
      <div className="mascot-antenna-cap" />
      <div className="mascot-head" />
      <div className="mascot-eye mascot-eye-left" />
      <div className="mascot-eye mascot-eye-right" />
      <div className="mascot-mouth" />
    </div>
  );
}
