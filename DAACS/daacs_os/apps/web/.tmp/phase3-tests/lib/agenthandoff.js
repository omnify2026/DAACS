"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handoffToNextAgent = handoffToNextAgent;
exports.attachHandoffsToInput = attachHandoffsToInput;
function assignedRoleLabel(runtimeBundle, assignedTo) {
    if (!assignedTo)
        return "unassigned";
    const instance = runtimeBundle.instances.find((candidate) => candidate.instance_id === assignedTo);
    if (!instance)
        return assignedTo;
    const blueprint = runtimeBundle.blueprints.find((candidate) => candidate.id === instance.blueprint_id);
    return blueprint?.role_label ?? assignedTo;
}
function inferHandoffType(nextStep) {
    const label = `${nextStep.label} ${nextStep.description}`.toLowerCase();
    if (label.includes("review") || label.includes("audit")) {
        return "review_request";
    }
    if (label.includes("feedback")) {
        return "feedback";
    }
    if (label.includes("question")) {
        return "question";
    }
    return "task_complete";
}
function handoffToNextAgent(runtimeBundle, completedStep, nextStep, result) {
    const fromRole = assignedRoleLabel(runtimeBundle, completedStep.assigned_to);
    const toRole = assignedRoleLabel(runtimeBundle, nextStep.assigned_to);
    return {
        from_agent_id: completedStep.assigned_to ?? fromRole,
        to_agent_id: nextStep.assigned_to ?? toRole,
        type: inferHandoffType(nextStep),
        content: [
            `Completed step: ${completedStep.label}`,
            `Next step: ${nextStep.label}`,
            `From: ${fromRole}`,
            `To: ${toRole}`,
            "",
            result.trim() || "(no result content)",
        ].join("\n"),
    };
}
function attachHandoffsToInput(input, handoffs) {
    if (handoffs.length === 0) {
        return input;
    }
    const inputRecord = input && typeof input === "object" && !Array.isArray(input)
        ? input
        : { original_input: input };
    const existing = Array.isArray(inputRecord.handoff_messages)
        ? inputRecord.handoff_messages
        : [];
    return {
        ...inputRecord,
        handoff_messages: [...existing, ...handoffs],
    };
}
