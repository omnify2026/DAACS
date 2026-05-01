import os
import glob
import re

count = 0
for filepath in glob.glob("/Users/david/.codex/skills/**/SKILL.md", recursive=True):
    try:
        with open(filepath, 'r') as f:
            lines = f.readlines()
            
        if not lines or not lines[0].startswith('---'):
            if lines: # Missing YAML block entirely but wait, the error says 'missing YAML frontmatter' for some.
                # Just skip or add empty frontmatter? Let's skip for now unless we really need to.
                if len(lines) > 0 and lines[0].strip() == '# odoo-shopify-integration':
                    pass # We'll deal with this if needed
            continue
            
        # Extract frontmatter
        yaml_end_idx = -1
        in_yaml = True
        keys_seen = set()
        
        cleaned_lines = [lines[0]]
        
        for i in range(1, len(lines)):
            line = lines[i]
            
            if in_yaml:
                if line.startswith('---'):
                    yaml_end_idx = i
                    in_yaml = False
                    cleaned_lines.append(line)
                    continue
                
                if line.strip() == '':
                    # Might be the end of yaml if no '---' found
                    # Let's peek ahead to see if there is a '---' later
                    has_dash_later = any(l.startswith('---') for l in lines[i+1:i+100])
                    if not has_dash_later:
                        # Insert closing dash
                        cleaned_lines.append('---\n')
                        cleaned_lines.append(line)
                        yaml_end_idx = i
                        in_yaml = False
                        continue
                
                # Check for duplicate top-level keys
                m = re.match(r'^([a-zA-Z0-9_\-]+):\s*(.*)', line)
                if m:
                    key = m.group(1)
                    if key in keys_seen:
                        # skip duplicate
                        continue
                    else:
                        keys_seen.add(key)
                        
                cleaned_lines.append(line)
            else:
                cleaned_lines.append(line)
                
        # If we reached EOF and still in YAML (no empty line, no '---')
        if in_yaml:
            cleaned_lines.append('\n---\n')
            
        # Write back if changed
        if lines != cleaned_lines:
            with open(filepath, 'w') as f:
                f.writelines(cleaned_lines)
            count += 1
            print(f"Fixed {filepath}")
            
    except Exception as e:
        print(f"Error processing {filepath}: {e}")

print(f"Total fixed: {count}")
