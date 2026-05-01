import argparse
import json
from typing import Any
from urllib import request, error


def EnsureNotNone(InValue: Any, InName: str) -> None:
    if InValue is None:
        raise ValueError(f"{InName} is required.")


def EnsureNotEmptyString(InValue: str, InName: str) -> None:
    EnsureNotNone(InValue, InName)
    if not isinstance(InValue, str):
        raise ValueError(f"{InName} must be a string.")
    if not InValue.strip():
        raise ValueError(f"{InName} cannot be empty.")


def HttpJsonRequest(InMethod: str, InUrl: str, InBody: dict[str, Any] | None = None) -> dict[str, Any]:
    EnsureNotEmptyString(InMethod, "InMethod")
    EnsureNotEmptyString(InUrl, "InUrl")

    OutData = None
    OutHeaders = {"Content-Type": "application/json"}
    if InBody is not None:
        OutData = json.dumps(InBody, ensure_ascii=False).encode("utf-8")

    OutRequest = request.Request(
        url=InUrl,
        data=OutData,
        headers=OutHeaders,
        method=InMethod.upper(),
    )
    try:
        with request.urlopen(OutRequest, timeout=60) as OutResponse:
            OutRaw = OutResponse.read().decode("utf-8")
            if not OutRaw.strip():
                return {}
            OutParsed = json.loads(OutRaw)
            if not isinstance(OutParsed, dict):
                raise ValueError("HTTP response must be a JSON object.")
            return OutParsed
    except error.HTTPError as OutEx:
        OutBody = OutEx.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {OutEx.code} {OutEx.reason}: {OutBody}") from OutEx
    except error.URLError as OutEx:
        raise RuntimeError(f"Cannot connect to URL: {InUrl}. {OutEx.reason}") from OutEx


def NormalizeToolArguments(InArguments: Any) -> dict[str, Any]:
    if InArguments is None:
        return {}
    if isinstance(InArguments, dict):
        return InArguments
    if isinstance(InArguments, str):
        OutText = InArguments.strip()
        if not OutText:
            return {}
        OutDecoded = json.loads(OutText)
        if not isinstance(OutDecoded, dict):
            raise ValueError("Tool arguments JSON must decode to an object.")
        return OutDecoded
    raise ValueError("Unsupported tool arguments format.")


def GetToolSchemas(InToolServerBaseUrl: str) -> list[dict[str, Any]]:
    EnsureNotEmptyString(InToolServerBaseUrl, "InToolServerBaseUrl")
    OutResponse = HttpJsonRequest("GET", f"{InToolServerBaseUrl.rstrip('/')}/tools")
    OutTools = OutResponse.get("tools")
    if OutTools is None:
        raise ValueError("Tool server response missing tools.")
    if not isinstance(OutTools, list):
        raise ValueError("tools must be a list.")
    return OutTools


def CallToolServer(InToolServerBaseUrl: str, InToolName: str, InArguments: dict[str, Any]) -> dict[str, Any]:
    EnsureNotEmptyString(InToolServerBaseUrl, "InToolServerBaseUrl")
    EnsureNotEmptyString(InToolName, "InToolName")
    EnsureNotNone(InArguments, "InArguments")
    if not isinstance(InArguments, dict):
        raise ValueError("InArguments must be an object.")

    OutRequestBody = {
        "InToolName": InToolName,
        "InArguments": InArguments,
    }
    return HttpJsonRequest("POST", f"{InToolServerBaseUrl.rstrip('/')}/tool-call", OutRequestBody)


def ChatWithOllama(
    InOllamaBaseUrl: str,
    InModel: str,
    InMessages: list[dict[str, Any]],
    InTools: list[dict[str, Any]],
) -> dict[str, Any]:
    EnsureNotEmptyString(InOllamaBaseUrl, "InOllamaBaseUrl")
    EnsureNotEmptyString(InModel, "InModel")
    EnsureNotNone(InMessages, "InMessages")
    EnsureNotNone(InTools, "InTools")

    OutPayload = {
        "model": InModel,
        "messages": InMessages,
        "stream": False,
        "tools": InTools,
    }
    return HttpJsonRequest("POST", f"{InOllamaBaseUrl.rstrip('/')}/api/chat", OutPayload)


def RunBridge(
    InPrompt: str,
    InModel: str,
    InOllamaBaseUrl: str,
    InToolServerBaseUrl: str,
    InMaxSteps: int,
) -> str:
    EnsureNotEmptyString(InPrompt, "InPrompt")
    EnsureNotEmptyString(InModel, "InModel")
    EnsureNotEmptyString(InOllamaBaseUrl, "InOllamaBaseUrl")
    EnsureNotEmptyString(InToolServerBaseUrl, "InToolServerBaseUrl")
    EnsureNotNone(InMaxSteps, "InMaxSteps")
    if not isinstance(InMaxSteps, int) or InMaxSteps <= 0:
        raise ValueError("InMaxSteps must be a positive integer.")

    OutTools = GetToolSchemas(InToolServerBaseUrl)
    OutMessages: list[dict[str, Any]] = [{"role": "user", "content": InPrompt}]

    for OutStep in range(InMaxSteps):
        OutChatResponse = ChatWithOllama(
            InOllamaBaseUrl=InOllamaBaseUrl,
            InModel=InModel,
            InMessages=OutMessages,
            InTools=OutTools,
        )
        OutMessage = OutChatResponse.get("message")
        if OutMessage is None or not isinstance(OutMessage, dict):
            raise ValueError("Ollama response missing message object.")

        OutMessages.append(OutMessage)
        OutToolCalls = OutMessage.get("tool_calls")
        if OutToolCalls is None or not isinstance(OutToolCalls, list) or len(OutToolCalls) == 0:
            OutContent = OutMessage.get("content", "")
            if OutContent is None:
                return ""
            if not isinstance(OutContent, str):
                return str(OutContent)
            return OutContent

        for OutToolCall in OutToolCalls:
            if OutToolCall is None or not isinstance(OutToolCall, dict):
                raise ValueError("Invalid tool_call item.")
            OutFunction = OutToolCall.get("function")
            if OutFunction is None or not isinstance(OutFunction, dict):
                raise ValueError("tool_call.function is required.")
            OutToolName = OutFunction.get("name")
            if OutToolName is None or not isinstance(OutToolName, str):
                raise ValueError("tool_call.function.name must be a string.")
            OutArguments = NormalizeToolArguments(OutFunction.get("arguments"))
            OutToolResult = CallToolServer(
                InToolServerBaseUrl=InToolServerBaseUrl,
                InToolName=OutToolName,
                InArguments=OutArguments,
            )
            OutMessages.append(
                {
                    "role": "tool",
                    "name": OutToolName,
                    "content": json.dumps(OutToolResult, ensure_ascii=False),
                }
            )

    raise RuntimeError(f"Tool loop exceeded InMaxSteps={InMaxSteps}.")


def ParseArguments() -> argparse.Namespace:
    OutParser = argparse.ArgumentParser(description="Ollama tool bridge for local tool server.")
    OutParser.add_argument("--prompt", required=True, help="User prompt")
    OutParser.add_argument("--model", default="qwen2.5:14b", help="Ollama model name")
    OutParser.add_argument("--ollama-url", default="http://127.0.0.1:11434", help="Ollama base URL")
    OutParser.add_argument("--tool-url", default="http://127.0.0.1:8000", help="Tool server base URL")
    OutParser.add_argument("--max-steps", type=int, default=8, help="Maximum tool loop steps")
    return OutParser.parse_args()


def Main() -> None:
    OutArgs = ParseArguments()
    OutFinalText = RunBridge(
        InPrompt=OutArgs.prompt,
        InModel=OutArgs.model,
        InOllamaBaseUrl=OutArgs.ollama_url,
        InToolServerBaseUrl=OutArgs.tool_url,
        InMaxSteps=OutArgs.max_steps,
    )
    print(OutFinalText)


if __name__ == "__main__":
    Main()
