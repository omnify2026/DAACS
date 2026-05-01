"""
Test script for Chat History Persistence

Quick manual verification that chat history save/load works correctly.
Run this to verify Phase A implementation.
"""

import sys
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from daacs.utils.chat_history import (
    save_chat_history,
    load_chat_history,
    clear_chat_history,
    get_chat_stats
)


def test_save_and_load():
    """Test basic save and load functionality"""
    print("=" * 60)
    print("Testing Chat History Persistence")
    print("=" * 60)
    
    project_id = "test_12345"
    pm_type = "ui"
    
    # Test messages
    test_messages = [
        {"role": "pm", "content": "Hello! I'm the UI PM."},
        {"role": "user", "content": "Hi! I want a dark theme."},
        {"role": "pm", "content": "Great choice! What's your target audience?"},
        {"role": "user", "content": "Developers and tech enthusiasts."},
    ]
    
    # 1. Save messages
    print(f"\n📝 Saving {len(test_messages)} messages for {pm_type} PM...")
    success = save_chat_history(project_id, pm_type, test_messages)
    if success:
        print("✅ Save successful")
    else:
        print("❌ Save failed")
        return False
    
    # 2. Load messages
    print(f"\n📖 Loading messages for {pm_type} PM...")
    loaded_messages = load_chat_history(project_id, pm_type)
    print(f"✅ Loaded {len(loaded_messages)} messages")
    
    # 3. Verify content
    print("\n🔍 Verifying content...")
    if len(loaded_messages) == len(test_messages):
        print("✅ Message count matches")
    else:
        print(f"❌ Message count mismatch: expected {len(test_messages)}, got {len(loaded_messages)}")
        return False
    
    for i, (original, loaded) in enumerate(zip(test_messages, loaded_messages)):
        if original == loaded:
            print(f"  ✅ Message {i+1} matches")
        else:
            print(f"  ❌ Message {i+1} mismatch:")
            print(f"     Expected: {original}")
            print(f"     Got: {loaded}")
            return False
    
    # 4. Get stats
    print("\n📊 Getting chat stats...")
    stats = get_chat_stats(project_id, pm_type)
    print(f"  Exists: {stats['exists']}")
    print(f"  Message count: {stats['message_count']}")
    print(f"  Last updated: {stats.get('updated_at', 'N/A')}")
    
    # 5. Test tech PM as well
    print(f"\n🔧 Testing Tech PM...")
    tech_messages = [
        {"role": "pm", "content": "Hello! I'm the Tech Lead."},
        {"role": "user", "content": "We need PostgreSQL database."},
    ]
    save_chat_history(project_id, "tech", tech_messages)
    loaded_tech = load_chat_history(project_id, "tech")
    if len(loaded_tech) == len(tech_messages):
        print("✅ Tech PM history saved and loaded correctly")
    else:
        print("❌ Tech PM history mismatch")
        return False
    
    # 6. Cleanup
    print(f"\n🧹 Cleaning up test data...")
    clear_chat_history(project_id)  # Clear both
    
    # Verify cleanup
    ui_after_clear = load_chat_history(project_id, "ui")
    tech_after_clear = load_chat_history(project_id, "tech")
    
    if len(ui_after_clear) == 0 and len(tech_after_clear) == 0:
        print("✅ Cleanup successful")
    else:
        print("❌ Cleanup failed - files still exist")
        return False
    
    print("\n" + "=" * 60)
    print("✅ ALL TESTS PASSED")
    print("=" * 60)
    return True


if __name__ == "__main__":
    try:
        success = test_save_and_load()
        sys.exit(0 if success else 1)
    except Exception as e:
        print(f"\n❌ Test failed with error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
