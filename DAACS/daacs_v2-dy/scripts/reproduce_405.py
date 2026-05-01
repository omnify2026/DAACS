
import requests
import json
import os

BASE_URL = "http://localhost:8001"

def test_create_project():
    url = f"{BASE_URL}/api/projects"
    payload = {
        "goal": "Test Project 405",
        "config": {}
    }
    headers = {
        "Content-Type": "application/json"
    }
    
    # Try POST (should work)
    print(f"Testing POST {url}...")
    try:
        response = requests.post(url, json=payload, headers=headers)
        print(f"POST Status: {response.status_code}")
        print(f"POST Response: {response.text}")
    except Exception as e:
        print(f"POST Failed: {e}")

    # Try GET (should return list)
    print(f"\nTesting GET {url}...")
    try:
        response = requests.get(url)
        print(f"GET Status: {response.status_code}")
        # print(f"GET Response: {response.text[:100]}")
    except Exception as e:
        print(f"GET Failed: {e}")

if __name__ == "__main__":
    test_create_project()
