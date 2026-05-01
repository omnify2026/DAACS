import glob
import re

count = 0
for filepath in glob.glob("/Users/david/.codex/skills/**/SKILL.md", recursive=True):
    try:
        with open(filepath, 'r') as f:
            content = f.read()
            
        # Check if it has a starting ---
        if not content.startswith('---'):
            # Some might not have --- at the start
            continue
            
        # Count the number of '---' at the start of a line
        dashes = re.findall(r'^---$', content, re.MULTILINE)
        
        if len(dashes) < 2:
            # Need to insert the closing ---
            # We look for the first markdown heading or blockquote
            match = re.search(r'\n(#[^\n]+|>[^\n]+|[\-\*]\s+[^\n]+)', content)
            if match:
                # Insert --- before the match
                idx = match.start()
                new_content = content[:idx] + '\n---\n' + content[idx:]
                with open(filepath, 'w') as f:
                    f.write(new_content)
                count += 1
                continue

    except Exception as e:
        print(f"Error {filepath}: {e}")

print(f"Total fixed: {count}")
