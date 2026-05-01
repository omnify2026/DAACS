"""
DAACS v7.0 - Common Network Utilities
Shared utilities for network operations across verification modules.
"""
import socket
from typing import List

# Default port range for finding free ports
DEFAULT_PORT_RANGE_START = 8000
DEFAULT_PORT_RANGE_END = 65535


def find_free_port(start_port: int = DEFAULT_PORT_RANGE_START) -> int:
    """
    Find an available port starting from start_port.
    
    Args:
        start_port: Port number to start searching from.
        
    Returns:
        Available port number.
    """
    port = start_port
    while port < DEFAULT_PORT_RANGE_END:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("0.0.0.0", port))
                return port
            except OSError:
                port += 1
    return start_port


def is_port_open(host: str, port: int, timeout: float = 1.0) -> bool:
    """
    Check if a port is open and accepting connections.
    
    Args:
        host: Hostname or IP address.
        port: Port number to check.
        timeout: Connection timeout in seconds.
        
    Returns:
        True if port is open, False otherwise.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        try:
            sock.connect((host, port))
            return True
        except (OSError, socket.timeout):
            return False


def wait_for_port(host: str, port: int, timeout: float = 30.0, interval: float = 0.5) -> bool:
    """
    Wait for a port to become available.
    
    Args:
        host: Hostname or IP address.
        port: Port number to wait for.
        timeout: Maximum time to wait in seconds.
        interval: Time between checks in seconds.
        
    Returns:
        True if port became available, False if timeout reached.
    """
    import time
    start_time = time.monotonic()
    while time.monotonic() - start_time < timeout:
        if is_port_open(host, port):
            return True
        time.sleep(interval)
    return False
