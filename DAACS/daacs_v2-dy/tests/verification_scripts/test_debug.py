"""
Manual debug script for exercising the web context provider end-to-end.

NOTE: Kept under tests for convenience, but guarded so it doesn't run during pytest
collection (it may require network access).
"""

import os
import shutil


def main() -> None:
    print("DEBUG: Script started", flush=True)

    try:
        print("DEBUG: Cleaning cache...", flush=True)
        if os.path.exists(".daacs_cache"):
            shutil.rmtree(".daacs_cache")
        print("DEBUG: Cache cleaned.", flush=True)

        print("DEBUG: Importing daacs.context.cache", flush=True)
        from daacs.context.cache import ContextCache

        print("DEBUG: ContextCache imported", flush=True)

        print("DEBUG: Importing daacs.context.search_client", flush=True)
        from daacs.context.search_client import DuckDuckGoSearchClient

        print("DEBUG: DuckDuckGoSearchClient imported", flush=True)

        print("DEBUG: Importing daacs.context.web_provider", flush=True)
        from daacs.context.web_provider import WebTechContextProvider
        from daacs.context.types import RFIResult

        print("DEBUG: WebTechContextProvider imported", flush=True)

        print("DEBUG: Instantiating components", flush=True)
        client = DuckDuckGoSearchClient()
        provider = WebTechContextProvider(search_client=client, cache=ContextCache())

        print("DEBUG: Running fetch", flush=True)
        rfi = RFIResult(language="python", platform="desktop", ui_required=False, constraints=["fast"])
        ctx = provider.fetch(rfi)
        print(f"DEBUG: Fetched facts: {len(ctx.facts)}", flush=True)

    except Exception as e:
        print(f"ERROR: {e}", flush=True)
        import traceback

        traceback.print_exc()

    print("DEBUG: Script finished", flush=True)


if __name__ == "__main__":
    main()
