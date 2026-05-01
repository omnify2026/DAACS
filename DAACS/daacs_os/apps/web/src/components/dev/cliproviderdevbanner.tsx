import { useCallback, useState, useEffect } from "react";
import { 
  isTauri, 
  getCliWhich, 
  runCliCommand, 
  DEFAULT_CLI_PROVIDER,
  getSavedCliProvider, 
  setSavedCliProvider,
  openLocalLlmDialog,
  getSavedLocalLlmBaseUrl,
  getSavedLocalLlmPath,
  localPathExists,
  listLocalLlmModels,
  openLocalLlmDirectoryDialog,
  setSavedLocalLlmPath
} from "../../services/tauriCli";
import type { LocalLlmCandidate } from "../../services/tauriCli";
import { useI18n } from "../../i18n";
import { useCliLogStore } from "../../stores/cliLogStore";

export function CliProviderDevBanner() {
  const { t } = useI18n();
  const [which, setWhich] = useState<{ preferred: string; codex: string | null; gemini: string | null } | null>(null);
  const [selected, setSelected] = useState<"gemini" | "codex" | "local_llm">(
    () => (getSavedCliProvider() as "gemini" | "codex" | "local_llm") ?? DEFAULT_CLI_PROVIDER
  );
  const [localLlmPath, setLocalLlmPath] = useState<string | null>(() => getSavedLocalLlmPath());
  const [localLlmCandidates, setLocalLlmCandidates] = useState<LocalLlmCandidate[]>([]);
  const [localLlmLoading, setLocalLlmLoading] = useState(false);
  
  const [verifyStatus, setVerifyStatus] = useState<"idle" | "running" | "ok" | "fail">("idle");
  const [verifyMessage, setVerifyMessage] = useState<string>("");

  useEffect(() => {
    if (!isTauri()) return;
    getCliWhich().then((w) => {
      if (w) setWhich(w);
    });
  }, []);

  const refreshLocalLlmCandidates = useCallback(async (): Promise<LocalLlmCandidate[]> => {
    if (!isTauri()) return [];
    setLocalLlmLoading(true);
    try {
      const candidates = await listLocalLlmModels();
      setLocalLlmCandidates(candidates);
      if (candidates.length === 0) {
        setVerifyStatus("fail");
        setVerifyMessage("감지된 로컬 모델이 없습니다. 폴더 버튼으로 모델을 직접 선택하세요.");
      }
      if (selected === "local_llm" && !localLlmPath) {
        if (candidates.length > 1) {
          setVerifyStatus("fail");
          setVerifyMessage(`로컬 모델 ${candidates.length}개 감지됨. 하나를 선택하세요.`);
        } else if (candidates.length === 1) {
          setVerifyStatus("idle");
          setVerifyMessage(`로컬 모델 1개 감지됨: ${candidates[0].name}`);
        }
      }
      return candidates;
    } catch (error) {
      const message = error instanceof Error ? error.message : "로컬 모델 감지 명령 실패";
      setLocalLlmCandidates([]);
      setVerifyStatus("fail");
      setVerifyMessage(`감지 실패: ${message}`);
      return [];
    } finally {
      setLocalLlmLoading(false);
    }
  }, [localLlmPath, selected]);

  useEffect(() => {
    if (!isTauri() || !localLlmPath) return;
    let cancelled = false;
    void localPathExists(localLlmPath).then((exists) => {
      if (cancelled || exists) return;
      setLocalLlmPath(null);
      setSavedLocalLlmPath(null);
      setVerifyStatus("fail");
      setVerifyMessage("저장된 로컬 모델 파일을 찾을 수 없습니다. 다시 선택하세요.");
      if (selected === "local_llm") {
        void refreshLocalLlmCandidates();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [localLlmPath, refreshLocalLlmCandidates, selected]);

  useEffect(() => {
    if (selected === "local_llm" && !localLlmPath && localLlmCandidates.length === 0) {
      let cancelled = false;
      setLocalLlmLoading(true);
      void listLocalLlmModels()
        .then((candidates) => {
          if (cancelled) return;
          setLocalLlmCandidates(candidates);
          if (candidates.length > 1) {
            setVerifyStatus("fail");
            setVerifyMessage(`로컬 모델 ${candidates.length}개 감지됨. 하나를 선택하세요.`);
          } else if (candidates.length === 1) {
            setVerifyStatus("idle");
            setVerifyMessage(`로컬 모델 1개 감지됨: ${candidates[0].name}`);
          } else {
            setVerifyStatus("fail");
            setVerifyMessage("감지된 로컬 모델이 없습니다. 폴더 버튼으로 모델을 직접 선택하세요.");
          }
        })
        .catch((error) => {
          if (cancelled) return;
          const message = error instanceof Error ? error.message : "로컬 모델 감지 명령 실패";
          setVerifyStatus("fail");
          setVerifyMessage(`감지 실패: ${message}`);
        })
        .finally(() => {
          if (!cancelled) setLocalLlmLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }
  }, [selected, localLlmPath, localLlmCandidates.length]);

  const handleSelect = (provider: "gemini" | "codex" | "local_llm") => {
    setSelected(provider);
    setSavedCliProvider(provider);
    setVerifyStatus("idle");
    setVerifyMessage("");
    if (provider === "local_llm" && !localLlmPath && localLlmCandidates.length === 0) {
      void refreshLocalLlmCandidates();
    }
  };

  const handleChooseLocalModel = async () => {
    const path = await openLocalLlmDialog();
    if (path) {
      setLocalLlmPath(path);
      setSavedLocalLlmPath(path);
      handleSelect("local_llm");
    }
  };

  const handleChooseLocalModelDirectory = async () => {
    const path = await openLocalLlmDirectoryDialog();
    if (path) {
      setLocalLlmPath(path);
      setSavedLocalLlmPath(path);
      handleSelect("local_llm");
    }
  };

  const handleChooseDetectedModel = (path: string) => {
    const selectedPath = path.trim();
    const nextPath = selectedPath === "" ? null : selectedPath;
    setLocalLlmPath(nextPath);
    setSavedLocalLlmPath(nextPath);
    handleSelect("local_llm");
  };

  const setPanelOpen = useCliLogStore((s) => s.setPanelOpen);
  const addEntry = useCliLogStore((s) => s.addEntry);

  const handleVerify = async () => {
    if (!isTauri()) return;
    setVerifyStatus("running");
    setVerifyMessage(selected === "local_llm" && !localLlmPath ? "로컬 모델 자동 탐색으로 연결 확인 중..." : "");

    if (selected === "local_llm") {
      let verifiedLocalLlmPath = localLlmPath;
      if (!verifiedLocalLlmPath) {
        const candidates =
          localLlmCandidates.length > 0 ? localLlmCandidates : await refreshLocalLlmCandidates();
        if (candidates.length === 1) {
          verifiedLocalLlmPath = candidates[0].path;
          setLocalLlmPath(verifiedLocalLlmPath);
          setSavedLocalLlmPath(verifiedLocalLlmPath);
          setVerifyMessage(`감지된 모델을 사용합니다: ${candidates[0].name}`);
        } else if (candidates.length > 1) {
          setVerifyStatus("fail");
          setVerifyMessage(`로컬 모델 ${candidates.length}개 감지됨. 하나를 선택하세요.`);
          return;
        } else {
          setVerifyStatus("fail");
          setVerifyMessage("감지된 로컬 모델이 없습니다. 파일 또는 MLX 모델 폴더를 직접 선택하세요.");
          return;
        }
      }
      const verifyIn = "Reply with exactly: OK";
      const result = await runCliCommand(verifyIn, {
        provider: "local_llm",
        localLlmPath: verifiedLocalLlmPath ?? null,
      });
      
      if (result != null) {
        addEntry({
          stdin: verifyIn,
          stdout: result.stdout,
          stderr: result.stderr,
          exit_code: result.exit_code,
          provider: result.provider,
          label: "Verify Local LLM",
          officeAgentRole: "pm",
        });
      }

      const rawOutput = result?.stdout || "";
      const rawError = result?.stderr || "";
      const combinedOutput = `${rawOutput}\n${rawError}`;
      if (/Multiple local LLM models were found/i.test(combinedOutput) || /multiple local/i.test(combinedOutput)) {
        const candidates = await refreshLocalLlmCandidates();
        setVerifyStatus("fail");
        setVerifyMessage(
          candidates.length > 1
            ? `로컬 모델 ${candidates.length}개 감지됨. 하나를 선택하세요.`
            : "로컬 모델이 여러 개 감지되었습니다. 감지를 눌러 모델을 선택하세요.",
        );
        return;
      }
      if (result == null || result.exit_code !== 0) {
        setVerifyStatus("fail");
        setVerifyMessage(rawError || "로컬 모델 실행 실패. CLI 로그를 확인해주세요.");
        return;
      }
      const ok = rawOutput.trim().toUpperCase().includes("OK");
      setVerifyStatus(ok ? "ok" : "fail");
      setVerifyMessage(ok ? t("cliDev.verifyOk") : `${t("cliDev.verifyUnexpected")}: ${rawOutput.slice(0, 60)}`);
      return;
    }

    const verifyIn = "Reply with exactly: OK";
    const result = await runCliCommand(verifyIn, {
      provider: selected,
      localLlmBaseUrl: getSavedLocalLlmBaseUrl(),
    });
    if (result != null) {
      addEntry({
        stdin: verifyIn,
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exit_code,
        provider: result.provider,
        label: "Verify",
        officeAgentRole: "pm",
      });
    }
    if (result == null) {
      setVerifyStatus("fail");
      setVerifyMessage(t("cliDev.verifyError"));
      return;
    }
    if (result.exit_code !== 0) {
      setVerifyStatus("fail");
      setVerifyMessage(`${t("cliDev.verifyError")} (exit ${result.exit_code}) ${(result.stderr || result.stdout || "").slice(0, 80)}`);
      return;
    }
    const ok = (result.stdout || "").trim().toUpperCase().includes("OK");
    setVerifyStatus(ok ? "ok" : "fail");
    setVerifyMessage(ok ? t("cliDev.verifyOk") : `${t("cliDev.verifyUnexpected")}: ${(result.stdout || "").slice(0, 60)}`);
  };

  if (!isTauri()) return null;



  const getFileName = (path: string | null) => {
    if (!path) return "Local LLM";
    const parts = path.split(/[/\\]/);
    return parts[parts.length - 1];
  };

  const formatModelSize = (sizeBytes: number) => {
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return "";
    const gb = sizeBytes / 1024 / 1024 / 1024;
    if (gb >= 1) return `${gb.toFixed(1)}GB`;
    return `${(sizeBytes / 1024 / 1024).toFixed(0)}MB`;
  };

  return (
    <div className="rounded-lg border border-amber-500/40 bg-[#111127]/90 backdrop-blur px-3 py-2 flex flex-wrap items-center gap-3 text-white shadow-lg">
      <span className="text-[10px] uppercase tracking-wider text-amber-400/90">{t("cliDev.label")}</span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => handleSelect("gemini")}
          className={`px-2.5 py-1 text-xs rounded transition-colors ${
            selected === "gemini"
              ? "bg-amber-500 text-black font-medium"
              : "text-gray-300 hover:bg-white/10"
          }`}
          title={which?.gemini ?? "Gemini CLI"}
        >
          Gemini
        </button>
        <button
          type="button"
          onClick={() => handleSelect("codex")}
          className={`px-2.5 py-1 text-xs rounded transition-colors ${
            selected === "codex"
              ? "bg-amber-500 text-black font-medium"
              : "text-gray-300 hover:bg-white/10"
          }`}
          title={which?.codex ?? "Codex CLI"}
        >
          Codex
        </button>
        <div className="flex items-center relative group">
          <button
            type="button"
            onClick={() => handleSelect("local_llm")}
            className={`px-2.5 py-1 text-xs rounded-l transition-colors ${
              selected === "local_llm"
                ? "bg-amber-500 text-black font-medium"
                : "text-gray-300 hover:bg-white/10"
            }`}
            title={localLlmPath ?? "Auto-detect local model via OmniAICore"}
          >
            {localLlmPath ? getFileName(localLlmPath).substring(0, 16) + "..." : "Local LLM"}
          </button>
          <button
            type="button"
            onClick={handleChooseLocalModel}
            className={`px-2.5 py-1 text-xs rounded-r transition-colors border-l border-white/20 ${
              selected === "local_llm"
                ? "bg-amber-600 text-black font-medium hover:bg-amber-400"
                : "bg-white/5 text-gray-300 hover:bg-white/20"
            }`}
            title="Choose local model file"
          >
            📄
          </button>
          <button
            type="button"
            onClick={handleChooseLocalModelDirectory}
            className={`px-2.5 py-1 text-xs rounded-r transition-colors border-l border-white/20 ${
              selected === "local_llm"
                ? "bg-amber-600 text-black font-medium hover:bg-amber-400"
                : "bg-white/5 text-gray-300 hover:bg-white/20"
            }`}
            title="Choose MLX or HuggingFace model directory"
          >
            📁
          </button>
          <button
            type="button"
            onClick={() => void refreshLocalLlmCandidates()}
            className={`px-2 py-1 text-xs rounded-r transition-colors border-l border-white/20 ${
              selected === "local_llm"
                ? "bg-amber-600 text-black font-medium hover:bg-amber-400"
                : "bg-white/5 text-gray-300 hover:bg-white/20"
            }`}
            title="Detect local model candidates"
          >
            {localLlmLoading ? "…" : "감지"}
          </button>
        </div>
      </div>
      {selected === "local_llm" && localLlmCandidates.length > 0 && (
        <select
          value={localLlmPath ?? ""}
          onChange={(event) => handleChooseDetectedModel(event.target.value)}
          className="max-w-[240px] rounded border border-amber-500/30 bg-[#0b0b1f] px-2 py-1 text-[10px] text-amber-100"
          title="Detected local models"
        >
          <option value="">모델 선택</option>
          {localLlmCandidates.map((candidate) => (
            <option key={candidate.path} value={candidate.path}>
              {candidate.name} · {candidate.kind}
              {formatModelSize(candidate.sizeBytes) ? ` · ${formatModelSize(candidate.sizeBytes)}` : ""}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        onClick={handleVerify}
        disabled={verifyStatus === "running"}
        className="px-2.5 py-1 text-xs rounded border border-cyan-500/50 text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-50 flex items-center gap-1"
      >
        {verifyStatus === "running" && <span className="animate-spin text-[10px]">⏳</span>}
        {verifyStatus === "running" ? t("cliDev.verifying") : t("cliDev.verify")}
      </button>
      {verifyStatus === "ok" && <span className="text-[10px] text-green-400">{verifyMessage}</span>}
      {verifyStatus === "fail" && (
        <span className="max-w-[360px] whitespace-normal text-[10px] leading-snug text-red-300" title={verifyMessage}>
          {verifyMessage}
        </span>
      )}
      <button
        type="button"
        onClick={() => setPanelOpen(true)}
        className="px-2.5 py-1 text-xs rounded border border-amber-500/50 text-amber-300/90 hover:bg-amber-500/20"
      >
        {t("cliDev.logTitle")}
      </button>
    </div>
  );
}
