import os
import sys
import logging
from logging.handlers import RotatingFileHandler
from typing import Optional

_LOGGING_CONFIGURED = False


class _StreamToLogger:
    def __init__(self, logger: logging.Logger, level: int) -> None:
        self.logger = logger
        self.level = level
        self._buffer = ""

    def write(self, message: str) -> int:
        if not message:
            return 0
        self._buffer += message
        while "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)
            if line:
                self.logger.log(self.level, line)
        return len(message)

    def flush(self) -> None:
        if self._buffer:
            self.logger.log(self.level, self._buffer)
            self._buffer = ""


def _configure_logging() -> None:
    global _LOGGING_CONFIGURED
    if _LOGGING_CONFIGURED:
        return
    _LOGGING_CONFIGURED = True

    level_name = os.getenv("DAACS_LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)
    formatter = logging.Formatter(
        fmt="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    root = logging.getLogger()
    root.setLevel(level)
    for handler in list(root.handlers):
        root.removeHandler(handler)

    log_file = os.getenv("DAACS_LOG_FILE")
    if log_file:
        max_bytes = int(os.getenv("DAACS_LOG_MAX_BYTES", "10485760"))
        backup_count = int(os.getenv("DAACS_LOG_BACKUP_COUNT", "5"))
        file_handler = RotatingFileHandler(
            log_file, maxBytes=max_bytes, backupCount=backup_count, encoding="utf-8"
        )
        file_handler.setFormatter(formatter)
        root.addHandler(file_handler)

        if os.getenv("DAACS_LOG_STDOUT", "false").lower() == "true":
            stream_handler = logging.StreamHandler()
            stream_handler.setFormatter(formatter)
            root.addHandler(stream_handler)
    else:
        stream_handler = logging.StreamHandler()
        stream_handler.setFormatter(formatter)
        root.addHandler(stream_handler)

    if os.getenv("DAACS_LOG_CAPTURE_STDIO", "false").lower() == "true":
        sys.stdout = _StreamToLogger(root, logging.INFO)
        sys.stderr = _StreamToLogger(root, logging.ERROR)


_configure_logging()
logger = logging.getLogger("DAACS")

def setup_logger(name: str) -> logging.Logger:
    """모듈별 로거를 생성합니다."""
    _configure_logging()
    return logging.getLogger(name)

def read_file(file_path: str) -> Optional[str]:
    """파일 내용을 읽어옵니다."""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            return f.read()
    except Exception as e:
        logger.error(f"Failed to read file {file_path}: {e}")
        return None

def write_file(file_path: str, content: str) -> bool:
    """파일에 내용을 씁니다."""
    try:
        dir_path = os.path.dirname(file_path)
        if dir_path:
            os.makedirs(dir_path, exist_ok=True)
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(content)
        logger.info(f"File written: {file_path}")
        return True
    except Exception as e:
        logger.error(f"Failed to write file {file_path}: {e}")
        return False
