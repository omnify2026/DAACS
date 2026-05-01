import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export async function runCliProviderDevBannerRegressionTests(): Promise<void> {
  const source = readFileSync(path.join(currentDir, "CliProviderDevBanner.tsx"), "utf8");
  const tauriPermissionSource = readFileSync(
    path.join(currentDir, "../../../../desktop/src-tauri/permissions/daacs-ipc.toml"),
    "utf8",
  );

  assert(
    source.includes("listLocalLlmModels") &&
      source.includes("localLlmCandidates") &&
      source.includes("모델 선택") &&
      source.includes("감지") &&
      source.includes("openLocalLlmDirectoryDialog"),
    "CLI provider banner should expose detected local models and allow MLX/HuggingFace model folder selection instead of hardcoding one preferred model",
  );

  assert(
    source.includes('const rawOutput = result?.stdout || "";') &&
      source.includes('const rawError = result?.stderr || "";') &&
      source.includes("const combinedOutput = `${rawOutput}\\n${rawError}`;") &&
      source.includes("/Multiple local LLM models were found/i.test(combinedOutput)") &&
      source.indexOf("/Multiple local LLM models were found/i.test(combinedOutput)") <
        source.indexOf("result == null || result.exit_code !== 0"),
    "CLI provider banner should translate multiple-local-model errors from stdout or stderr before showing raw CLI failure text",
  );

  assert(
    source.includes("감지된 로컬 모델이 없습니다. 파일 또는 MLX 모델 폴더를 직접 선택하세요.") &&
      source.indexOf("감지된 로컬 모델이 없습니다. 파일 또는 MLX 모델 폴더를 직접 선택하세요.") <
        source.indexOf("const verifyIn = \"Reply with exactly: OK\";"),
    "CLI provider banner should not run Local LLM verification with an empty model path after discovery returns no candidates",
  );

  assert(
    tauriPermissionSource.includes('"list_local_llm_models"'),
    "Desktop Tauri permissions should allow Local LLM discovery so the Detect button can populate the model selector",
  );

  assert(
    source.includes("감지 실패:") &&
      source.includes("감지된 로컬 모델이 없습니다") &&
      source.includes("max-w-[360px] whitespace-normal") &&
      !source.includes("text-red-400 max-w-[140px] truncate") &&
      source.indexOf("catch (error)") > source.indexOf("await listLocalLlmModels()"),
    "CLI provider banner should show full Local LLM discovery failures instead of making Detect look like a dead button or truncating the action needed",
  );

  assert(
    source.includes("localPathExists") &&
      source.includes("저장된 로컬 모델 파일을 찾을 수 없습니다") &&
      source.includes("setSavedLocalLlmPath(null)") &&
      source.indexOf("localPathExists(localLlmPath)") < source.indexOf("저장된 로컬 모델 파일을 찾을 수 없습니다"),
    "CLI provider banner should clear a stale saved Local LLM path instead of looking connected to a deleted model",
  );
}
