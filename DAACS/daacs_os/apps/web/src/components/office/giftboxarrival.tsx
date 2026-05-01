import { motion, AnimatePresence } from "framer-motion";
import { useI18n } from "../../i18n";

interface Props {
  visible: boolean;
  label?: string;
}

export function GiftBoxArrival({ visible, label }: Props) {
  const { t } = useI18n();
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ scale: 0.6, opacity: 0, y: 30 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.8, opacity: 0, y: -20 }}
          transition={{ type: "spring", stiffness: 280, damping: 20 }}
          className="absolute right-6 top-16 z-40 bg-amber-500 text-black px-4 py-2 rounded-xl font-bold shadow-xl"
        >
          {label ?? t("gift.newAgentArrived")}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
