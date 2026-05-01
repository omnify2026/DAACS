interface Props {
  onBuy: () => void;
  label?: string;
}

export function EmptySlot({ onBuy, label = "+ 슬롯 구매" }: Props) {
  return (
    <button
      onClick={onBuy}
      className="w-24 h-24 rounded-xl border-2 border-dashed border-cyan-500/50 text-cyan-300 text-xs hover:bg-cyan-500/10"
    >
      {label}
    </button>
  );
}
