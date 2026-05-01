# daacs.utils package

# Re-export commonly used utilities
try:
    from ..server_helpers import setup_logger
except ImportError:
    # Fallback if setup_logger doesn't exist
    import logging
    def setup_logger(name):
        return logging.getLogger(name)

