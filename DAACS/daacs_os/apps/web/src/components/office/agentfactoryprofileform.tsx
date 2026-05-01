import type { FactoryTemplate } from "../../lib/runtimeBuilder";
import type { TranslateFn } from "./agentFactoryShared";

interface Props {
  t: TranslateFn;
  selectedTemplate: FactoryTemplate;
  name: string;
  roleLabel: string;
  capabilities: string;
  onNameChange: (value: string) => void;
  onRoleLabelChange: (value: string) => void;
  onCapabilitiesChange: (value: string) => void;
}

export function AgentFactoryProfileForm({
  t,
  selectedTemplate,
  name,
  roleLabel,
  capabilities,
  onNameChange,
  onRoleLabelChange,
  onCapabilitiesChange,
}: Props) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <label className="block">
        <div className="mb-1 text-xs text-gray-400">{t("factory.field.name")}</div>
        <input
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          className="w-full rounded-lg border border-[#374151] bg-[#0b1220] px-3 py-2"
          placeholder={`${selectedTemplate.label} Agent`}
        />
      </label>
      <label className="block">
        <div className="mb-1 text-xs text-gray-400">{t("factory.field.agentId")}</div>
        <input
          value={roleLabel}
          onChange={(event) => onRoleLabelChange(event.target.value)}
          className="w-full rounded-lg border border-[#374151] bg-[#0b1220] px-3 py-2"
          placeholder={selectedTemplate.roleLabel}
        />
      </label>
      <label className="block md:col-span-2">
        <div className="mb-1 text-xs text-gray-400">{t("factory.field.capabilities")}</div>
        <input
          value={capabilities}
          onChange={(event) => onCapabilitiesChange(event.target.value)}
          className="w-full rounded-lg border border-[#374151] bg-[#0b1220] px-3 py-2"
          placeholder={selectedTemplate.capabilities.join(", ")}
        />
      </label>
    </div>
  );
}
