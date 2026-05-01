import { pathToFileURL } from "node:url";

import React from "react";
import { renderToString } from "react-dom/server";

import { dictionaries, tStatic, useI18n } from "./i18n";

const featureCriticalKeys = [
  "track.settingsEntryHint",
  "hud.menu.byokSettings",
  "owner.approve",
  "owner.hold",
  "owner.reject",
  "messenger.processed",
  "messenger.processFailed",
] as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function extractKeys(locale: "ko" | "en"): string[] {
  return Object.keys(dictionaries[locale]).sort();
}

function FallbackI18nProbe() {
  const { t } = useI18n();
  return React.createElement("span", null, t("auth.login"));
}

export async function runI18nRegressionTests(): Promise<void> {
  const koKeys = extractKeys("ko");
  const enKeys = extractKeys("en");

  assert(koKeys.length > 0, "Expected to extract Korean translation keys");
  assert(enKeys.length > 0, "Expected to extract English translation keys");
  assert(koKeys.length === enKeys.length, `Expected matching locale key counts, got ko=${koKeys.length}, en=${enKeys.length}`);

  const koSet = new Set(koKeys);
  const enSet = new Set(enKeys);
  const missingInEnglish = koKeys.filter((key) => !enSet.has(key));
  const missingInKorean = enKeys.filter((key) => !koSet.has(key));

  assert(
    missingInEnglish.length === 0,
    `English locale is missing keys present in Korean: ${missingInEnglish.join(", ")}`,
  );
  assert(
    missingInKorean.length === 0,
    `Korean locale is missing keys present in English: ${missingInKorean.join(", ")}`,
  );

  for (const requiredKey of featureCriticalKeys) {
    assert(koSet.has(requiredKey), `Expected Korean locale to include ${requiredKey}`);
    assert(enSet.has(requiredKey), `Expected English locale to include ${requiredKey}`);
    assert(
      dictionaries.ko[requiredKey].trim().length > 0,
      `Expected Korean locale value for ${requiredKey} to be non-empty`,
    );
    assert(
      dictionaries.en[requiredKey].trim().length > 0,
      `Expected English locale value for ${requiredKey} to be non-empty`,
    );
  }

  assert(tStatic("auth.login").trim().length > 0, "Expected tStatic to translate without browser globals");
  const fallbackRendered = renderToString(React.createElement(FallbackI18nProbe));
  assert(
    fallbackRendered.includes(dictionaries.en["auth.login"]) || fallbackRendered.includes(dictionaries.ko["auth.login"]),
    "Expected useI18n fallback to render instead of crashing outside I18nProvider",
  );

  console.log("i18n locale key parity regression passed");
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry != null && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  void runI18nRegressionTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
