const PITCH = 59;
const CELL = 44;
const STEM = "M0 59h103v162H59v-13H44v13H0z";

const baseCells = [
  ...Array.from({ length: 6 }, (_, column) => ({ x: column * PITCH, y: 0 })),
  ...[3, 4, 5].map((column) => ({ x: column * PITCH, y: PITCH })),
  ...[2, 3, 4, 5].map((column) => ({ x: column * PITCH, y: PITCH * 2 })),
  ...[2, 3, 4, 5].map((column) => ({ x: column * PITCH, y: PITCH * 3 })),
  ...[0, 1, 2, 3, 5].map((column) => ({
    x: column * PITCH,
    y: PITCH * 4,
  })),
  ...Array.from({ length: 6 }, (_, column) => ({
    x: column * PITCH,
    y: PITCH * 5,
  })),
];

/** NOMO's six-by-six grid mark, matching the supplied logo artwork. */
export function BrandMark({ className = "" }: { className?: string }) {
  return (
    <svg
      className={"nomo-grid-mark " + className}
      viewBox="0 0 339 339"
      fill="none"
      aria-hidden="true"
    >
      <g fill="currentColor">
        {baseCells.map(({ x, y }) => (
          <rect key={`${x}-${y}`} x={x} y={y} width={CELL} height={CELL} />
        ))}
        <path d={STEM} />
      </g>
      <rect x="118" y="59" width="44" height="44" fill="#ff705e" />
      <rect x="236" y="236" width="44" height="44" fill="#00a9bd" />
    </svg>
  );
}
