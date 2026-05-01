
import sys
import os
# Add the project root to sys.path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from daacs.server import app

def print_routes():
    print("Registered Routes:")
    for route in app.routes:
        if hasattr(route, "methods"):
            print(f"{route.path} {route.methods}")
        else:
            print(f"{route.path} (WebSocket/Static)")

if __name__ == "__main__":
    print_routes()
