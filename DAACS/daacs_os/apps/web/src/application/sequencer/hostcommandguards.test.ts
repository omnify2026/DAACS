import { pathToFileURL } from "node:url";

import { isInvalidSequencerCliCommand, isLikelyMalformedShellCommand } from "./HostCommandGuards";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export async function runHostCommandGuardsRegressionTests(): Promise<void> {
  const invalidCommands = [
    "echo plan > plan.md",
    "type NUL > plan.md",
    "git reset --hard HEAD",
    "git checkout -- apps/web/src/App.tsx",
    "git checkout --worktree -- apps/web/src/App.tsx",
    "git checkout -- .",
    "cd apps/web && git checkout -- src/App.tsx",
    "rm -rf tmp/verification",
    "python3 DAACS_OS/services/api/daacs/server.py",
    "pytest services/api/tests/test_workflows.py",
    "uvicorn daacs.server:app --reload",
    "fastapi dev DAACS_OS/services/api/daacs/server.py",
    "flask run",
    "# No specific build commands required for this vanilla JS/CSS project.",
    "true",
    "[Command]\n1. npm run build\n[/Command]",
    "First shell command: npm run build",
    "```sh\nnpm run build\n```",
    "cd apps/web && node --input-type=module <<'NODE'",
    "> test",
    "`npm test` 실행 결과가 아직 없어서 실제 런타임 통과는 미확인입니다.",
    "npm test 실행 결과 확인이 아직 필요합니다.",
  ];

  for (const command of invalidCommands) {
    assert(
      isInvalidSequencerCliCommand(command),
      `Sequencer command guard should reject unsafe or placeholder command: ${command}`,
    );
  }

  const validCommands = [
    "npm --prefix apps/web run build",
    "pnpm --dir apps/web test -- sequencer",
    "cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml",
    "python3 -m unittest tests/test_rules.py",
  ];

  for (const command of validCommands) {
    assert(
      !isInvalidSequencerCliCommand(command),
      `Sequencer command guard should allow concrete host command: ${command}`,
    );
  }

  assert(isLikelyMalformedShellCommand("npm run \"build"), "Unbalanced quotes should be malformed");
  assert(!isLikelyMalformedShellCommand("npm run \"build\""), "Balanced quotes should be accepted");
  assert(
    !isLikelyMalformedShellCommand("node --input-type=module <<'NODE'\nconsole.log('ok');\nNODE"),
    "Complete heredoc commands should be accepted",
  );
  assert(
    isLikelyMalformedShellCommand("node --input-type=module <<'NODE'\nconsole.log('ok');"),
    "Missing heredoc terminator should be malformed",
  );

  console.log("HostCommandGuards command safety regression passed");
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry != null && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  void runHostCommandGuardsRegressionTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
