type Translate = (czech: string, english: string) => string;

const LABELS: Readonly<Record<string, readonly [string, string]>> = {
  running: ["Běží", "Running"],
  queued: ["Ve frontě", "Queued"],
  pending: ["Čeká", "Pending"],
  "awaiting-approval": ["Čeká na schválení", "Awaiting approval"],
  stopping: ["Zastavuje se", "Stopping"],
  stopped: ["Zastaven", "Stopped"],
  cancelled: ["Zrušeno", "Cancelled"],
  failed: ["Selhal", "Failed"],
  unknown: ["Výsledek neznámý", "Outcome unknown"],
  paused: ["Pozastaven", "Paused"],
  idle: ["Neaktivní", "Idle"],
  approved: ["Schváleno", "Approved"],
  denied: ["Zamítnuto", "Denied"],
  allow: ["Povolit", "Allow"],
  hold: ["Pozdržet", "Hold"],
  deny: ["Zamítnout", "Deny"],
  expired: ["Vypršelo", "Expired"],
  restored: ["Obnoveno", "Restored"],
  partial: ["Částečně obnoveno", "Partially restored"],
  conflict: ["Konflikt", "Conflict"],
  missing: ["Chybí zdroj", "Missing source"],
  "not-successful": ["Nebyla úspěšná", "Not successful"],
  compensated: ["Kompenzováno", "Compensated"],
  "blocked-by-conflict": ["Blokováno konfliktem", "Blocked by conflict"],
};

export function statusLabel(
  value: unknown,
  t: Translate,
): string {
  if (value === undefined || value === null || value === "") return ", ";
  const text = String(value);
  const labels = LABELS[text];
  return labels ? t(labels[0], labels[1]) : text;
}
