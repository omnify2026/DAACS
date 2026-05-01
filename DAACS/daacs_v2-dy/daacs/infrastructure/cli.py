
import sys
import os
import argparse
import logging
import subprocess
import time
from pathlib import Path

# Ensure daacs package is in path
sys.path.append(str(Path(__file__).resolve().parents[2]))

from daacs import config
from daacs.infrastructure.process_manager import ProcessManager

# Configure Logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S"
)
logger = logging.getLogger("DAACS_CLI")

def stop_all(args):
    """Stops all DAACS related processes."""
    logger.info("🛑 Stopping all DAACS services...")
    
    # Kill by ports
    ports = [
        config.DAACS_PORT, 
        config.FRONTEND_PREVIEW_PORT, 
        config.DAACS_SERVICE_PORT, 
        config.FRONTEND_PORT
    ]
    for port in ports:
        if ProcessManager.is_port_in_use(port):
            logger.info(f"Checking port {port}...")
            ProcessManager.kill_processes_by_port(port)
            
    # Kill by name patterns
    patterns = ["daacs.server", "daacs.api", "vite", "uvicorn", "next-server"]
    for pattern in patterns:
        ProcessManager.kill_processes_by_name_pattern(pattern)
        
    logger.info("✨ All DAACS processes stopped.")

def start_backend(args):
    """Starts the DAACS backend server."""
    # First stop existing
    ProcessManager.kill_processes_by_name_pattern("daacs.server")
    ProcessManager.kill_processes_by_port(config.DAACS_PORT)
    
    logger.info("🚀 Starting DAACS Backend Server...")
    
    # Log Rotation (Basic implementation mimicking restart_api.sh)
    log_file = Path("daacs_api.log")
    if log_file.exists() and log_file.stat().st_size > 10 * 1024 * 1024: # 10MB
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        backup = Path(f"daacs_api.{timestamp}.log")
        log_file.rename(backup)
        logger.info(f"Rotated log file to {backup}")

    # Start Proess
    # We use Popen to start it in background/detached mode if needed, 
    # but for this CLI usually we might want to run it directly or detached.
    # The shell script used nohup.
    
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    
    if args.daemon:
        with open("daacs_api.log", "a") as out:
            subprocess.Popen(
                [sys.executable, "-m", "daacs.server"],
                stdout=out,
                stderr=out,
                env=env,
                cwd=os.getcwd(),
                start_new_session=True 
            )
        logger.info("✅ Backend started in background. Logs: daacs_api.log")
    else:
        # Run in foreground
        try:
            subprocess.run([sys.executable, "-m", "daacs.server"], env=env, check=True)
        except KeyboardInterrupt:
            logger.info("Backend stopped by user.")

def main():
    parser = argparse.ArgumentParser(description="DAACS Infrastructure CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)
    
    # Stop Command
    subparsers.add_parser("stop-all", help="Stop all DAACS processes")
    
    # Start Backend Command
    start_parser = subparsers.add_parser("start-backend", help="Start DAACS Backend")
    start_parser.add_argument("-d", "--daemon", action="store_true", help="Run in background")
    
    if len(sys.argv) == 1:
        parser.print_help()
        sys.exit(1)
        
    args = parser.parse_args()
    
    if args.command == "stop-all":
        stop_all(args)
    elif args.command == "start-backend":
        start_backend(args)

if __name__ == "__main__":
    main()
