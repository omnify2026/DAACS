export function ActionButton({
  label,
  command,
  onRunCommand,
}: {
  label: string;
  command: string;
  onRunCommand: (text: string) => Promise<void>;
}) {
  return (
    <button
      type="button"
      onClick={() => void onRunCommand(command)}
      className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white hover:bg-white/10"
    >
      {label}
    </button>
  );
}

export function IntentButton({
  label,
  onCreateIntent,
}: {
  label: string;
  onCreateIntent: () => Promise<void>;
}) {
  return (
    <button
      type="button"
      onClick={() => void onCreateIntent()}
      className="rounded-lg border border-amber-400/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-500/15"
    >
      {label}
    </button>
  );
}

export function EmptyState({ label }: { label: string }) {
  return <div className="text-sm text-gray-400">{label}</div>;
}
