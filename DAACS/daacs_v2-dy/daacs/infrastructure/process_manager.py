
import os
import signal
import time
import logging
import psutil
from typing import List, Optional

from ..config import PROCESS_SHUTDOWN_TIMEOUT

logger = logging.getLogger(__name__)

class ProcessManager:
    """
    Safely manages system processes, replacing aggressive shell scripts.
    Implements graceful shutdown (SIGTERM) with timeout before SIGKILL.
    """

    @staticmethod
    def kill_processes_by_port(port: int, timeout: int = 5) -> None:
        """
        Kills any process listening on the specified port.
        """
        for proc in psutil.process_iter(['pid', 'name']):
            try:
                # access connections explicitly
                connections = proc.connections(kind='inet')
                for conn in connections:
                    if conn.laddr.port == port:
                        ProcessManager._terminate_process(proc, timeout)
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                continue

    @staticmethod
    def kill_processes_by_name_pattern(pattern: str, timeout: int = 5) -> None:
        """
        Kills processes whose command line matches the given pattern.
        """
        for proc in psutil.process_iter(['pid', 'name', 'cmdline']):
            try:
                cmdline = proc.info.get('cmdline')
                if cmdline and any(pattern in arg for arg in cmdline):
                    ProcessManager._terminate_process(proc, timeout)
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                continue

    @staticmethod
    def _terminate_process(proc: psutil.Process, timeout: int) -> None:
        """
        Attempts to terminate a process gracefully, then forcefully if needed.
        """
        pid = proc.pid
        name = proc.name()
        
        logger.info(f"🛑 Stopping process {name} (PID: {pid})...")
        
        try:
            proc.terminate() # SIGTERM
            try:
                proc.wait(timeout=timeout)
                logger.info(f"✅ Process {name} (PID: {pid}) terminated gracefully.")
            except psutil.TimeoutExpired:
                logger.warning(f"⚠️ Process {name} (PID: {pid}) did not exit after {timeout}s. Force killing...")
                proc.kill() # SIGKILL
                proc.wait(timeout=PROCESS_SHUTDOWN_TIMEOUT)
                logger.info(f"💀 Process {name} (PID: {pid}) force killed.")
        except psutil.NoSuchProcess:
            logger.info(f"Process {name} (PID: {pid}) already gone.")
        except Exception as e:
            logger.error(f"❌ Failed to terminate process {name} (PID: {pid}): {e}")

    @staticmethod
    def is_port_in_use(port: int) -> bool:
        """Checks if a port is currently in use."""
        for proc in psutil.process_iter(['pid', 'name']):
            try:
                connections = proc.connections(kind='inet')
                for conn in connections:
                    if conn.laddr.port == port:
                        return True
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        return False
