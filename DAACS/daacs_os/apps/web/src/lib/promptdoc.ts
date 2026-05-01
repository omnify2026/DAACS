export type ParsedPromptDoc = {
  description: string;
  contentText: string;
};

export function parsePromptDocFromJson(raw: string): ParsedPromptDoc {
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return { description: "", contentText: "" };
  }
  if (root == null || typeof root !== "object" || Array.isArray(root)) {
    return { description: "", contentText: "" };
  }
  const o = root as Record<string, unknown>;
  const description = typeof o.description === "string" ? o.description : "";
  const c = o.content;
  if (typeof c === "string") {
    return { description, contentText: c };
  }
  if (Array.isArray(c)) {
    return {
      description,
      contentText: c.map((line) => String(line ?? "")).join("\n"),
    };
  }
  return { description, contentText: "" };
}

export function serializePromptDocForJson(description: string, contentText: string): string {
  const lines = contentText === "" ? [] : contentText.split("\n");
  return JSON.stringify(
    {
      description: description.trim(),
      content: lines,
    },
    null,
    2,
  );
}
