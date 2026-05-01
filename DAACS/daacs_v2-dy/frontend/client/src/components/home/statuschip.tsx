type StatusChipProps = {
    status: string;
};

export function StatusChip({ status }: StatusChipProps) {
    const colorClass =
        status === "completed"
            ? "bg-green-500/10 text-green-600 dark:text-green-400 border-green-200/50 dark:border-green-900/30"
            : status === "completed_with_warnings"
                ? "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-200/50 dark:border-yellow-900/30"
                : status === "running"
                    ? "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-200/50 dark:border-blue-900/30"
                    : status === "failed"
                        ? "bg-red-500/10 text-red-600 dark:text-red-400 border-red-200/50 dark:border-red-900/30"
                        : "bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-200/50 dark:border-gray-800";
    const label = status === "completed_with_warnings" ? "completed (warn)" : status;

    return (
        <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${colorClass} uppercase tracking-wider`}>
            {label}
        </span>
    );
}
