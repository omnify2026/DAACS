from typing import Any, Dict, List


def _create_files_txt_actions() -> List[Dict[str, Any]]:
    """Generate actions to create files.txt."""
    return [
        {
            "action": "dev_instruction",
            "type": "shell",
            "instruction": (
                "List all non-hidden files and directories (exclude dotfiles) in the current folder and save them to files.txt. "
                "Use `find . -maxdepth 1 -mindepth 1 -not -name \"files.txt\" -not -path \"./.*\" | sed 's|^./||' | sort > files.txt`. "
                "Do NOT use ls -a. Exclude files.txt from the output. Sort the names one per line. If files.txt exists, overwrite it."
            ),
            "verify": [
                "files_exist:files.txt",
                "files_not_empty:files.txt",
                "files_no_hidden:files.txt",
                "files_match_listing:files.txt"
            ],
            "comment": "Create a file list",
            "targets": ["files.txt"],
            "client": "frontend"
        }
    ]


def _create_pynet_actions() -> List[Dict[str, Any]]:
    """Generate actions for the PyNet hacking simulation scenario."""
    return [
        {
            "action": "dev_instruction",
            "type": "shell",
            "instruction": "mkdir -p project/pynet/tests",
            "verify": [],
            "comment": "Ensure PyNet package folders exist",
            "targets": ["project/pynet"]
        },
        {
            "action": "dev_instruction",
            "type": "shell",
            "instruction": (
                "Write project/pynet/server.py with a Server class (attrs: hostname, money_max, money_available, security_level, min_security, ram) "
                "and methods grow(multiplier -> caps money, raises security), weaken(amount -> floors at min_security), "
                "hack(skill -> steals up to 10% scaled by skill/security, raises security). Use type hints/docstrings."
            ),
            "verify": [],
            "comment": "Server core logic",
            "targets": ["project/pynet/server.py"],
            "client": "frontend"
        },
        {
            "action": "dev_instruction",
            "type": "shell",
            "instruction": (
                "Write project/pynet/player.py with Player(hacking_skill, money) and methods gain_exp, gain_money, with type hints/docstrings."
            ),
            "verify": [],
            "comment": "Player model",
            "targets": ["project/pynet/player.py"],
            "client": "frontend"
        },
        {
            "action": "dev_instruction",
            "type": "shell",
            "instruction": (
                "Write project/pynet/engine.py with GameEngine managing Player and servers "
                "(n00b, foodnstuff, sigma-cosmetics, joesguns, hong-fang-tea, harakiri-sushi, iron-gym). "
                "Expose get_server, scan_network (sorted), hack_target, grow_target, weaken_target with result strings and exp/money updates."
            ),
            "verify": [],
            "comment": "Game engine",
            "targets": ["project/pynet/engine.py"],
            "client": "frontend"
        },
        {
            "action": "dev_instruction",
            "type": "shell",
            "instruction": (
                "Write project/pynet/cli.py using argparse with commands scan/status/hack/grow/weaken. "
                "Wire to GameEngine, print outputs, main(argv=None, engine=None) -> int, helper to print lines."
            ),
            "verify": [],
            "comment": "CLI interface",
            "targets": ["project/pynet/cli.py"],
            "client": "frontend"
        },
        {
            "action": "dev_instruction",
            "type": "shell",
            "instruction": (
                "Add tests: project/pynet/tests/test_server.py (grow/weaken/hack), "
                "test_player.py (exp/money), test_engine.py (scan, hack success/failure, grow/weaken), "
                "test_cli.py (scan output, hack+status). Use pytest and asserts."
            ),
            "verify": [],
            "comment": "PyNet test suite",
            "targets": [
                "project/pynet/tests/test_server.py",
                "project/pynet/tests/test_player.py",
                "project/pynet/tests/test_engine.py",
                "project/pynet/tests/test_cli.py",
            ],
            "client": "frontend"
        },
        {
            "action": "dev_instruction",
            "type": "codegen",
            "instruction": (
                "Update pytest.ini to ensure project, project/pynet, project/room_deco, project/todo, project/calculator are on pythonpath; "
                "add project/pynet/__init__.py exporting GameEngine, Player, Server."
            ),
            "verify": [],
            "comment": "Test path wiring",
            "targets": ["pytest.ini", "project/pynet/__init__.py"],
            "client": "frontend"
        },
        {
            "action": "dev_instruction",
            "type": "test",
            "instruction": (
                "Run pytest with coverage on project/pynet to ensure >=80%: "
                "PYTHONPATH=\"project:project/room_deco:project/todo:project/calculator:project/pynet\" "
                "pytest --maxfail=1 --cov=project/pynet --cov-fail-under=80 -q"
            ),
            "verify": ["tests_pass"],
            "comment": "Validate PyNet with coverage",
            "targets": [],
            "client": "backend"
        },
    ]


def _create_default_scaffold(goal: str) -> List[Dict[str, Any]]:
    """Create generic project scaffold actions."""
    return [
        {
            "action": "dev_instruction",
            "type": "shell",
            "instruction": f"Create a minimal project scaffold for: {goal}\nOnly create folder structure and empty placeholder files. Do NOT implement any logic yet.",
            "verify": [],
            "comment": "Step 1: Create project scaffold",
            "targets": [],
            "client": "frontend"
        },
        {
            "action": "dev_instruction",
            "type": "codegen",
            "instruction": f"Implement the core functionality for: {goal}\nUse the scaffold from previous step. Keep implementation minimal and focused.",
            "verify": [],
            "comment": "Step 2: Implement core logic",
            "targets": [],
            "client": "frontend"
        },
        {
            "action": "dev_instruction",
            "type": "test",
            "instruction": f"Create a simple test file to verify the implementation works for: {goal}\nRun the test and report results.",
            "verify": ["tests_pass"],
            "comment": "Step 3: Add basic tests",
            "targets": [],
            "client": "frontend"
        }
    ]


def build_fallback_actions(goal: str) -> List[Dict[str, Any]]:
    """Fallback actions when LLM is disabled or unavailable."""
    goal_lower = goal.lower()
    
    if "files.txt" in goal_lower or "파일 목록" in goal_lower:
        return _create_files_txt_actions()
        
    if any(kw in goal_lower for kw in ["pynet", "hacking sim", "bitburner"]):
        return _create_pynet_actions()
        
    return _create_default_scaffold(goal)
