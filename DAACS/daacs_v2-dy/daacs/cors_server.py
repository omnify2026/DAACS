#!/usr/bin/env python3
"""
Simple HTTP server with CORS support for project preview.
"""

import http.server
import socketserver
import sys
import logging

# Basic logging configuration for standalone server
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger("CorsServer")

class CORSRequestHandler(http.server.SimpleHTTPRequestHandler):
    """HTTP handler with CORS headers for iframe embedding."""
    
    def end_headers(self):
        # Add CORS headers to allow embedding in iframes
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('X-Frame-Options', 'ALLOWALL')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        super().end_headers()
    
    def do_OPTIONS(self):
        """Handle CORS preflight requests."""
        self.send_response(200)
        self.end_headers()

def main():
    if len(sys.argv) < 2:
        print("Usage: python cors_server.py <port> [directory]") # Keep print for CLI help
        sys.exit(1)
    
    port = int(sys.argv[1])
    directory = sys.argv[2] if len(sys.argv) > 2 else os.getcwd()
    
    os.chdir(directory)
    
    with socketserver.TCPServer(("", port), CORSRequestHandler) as httpd:
        logger.info(f"Serving at http://localhost:{port}")
        logger.info(f"Directory: {directory}")
        httpd.serve_forever()

if __name__ == "__main__":
    main()
