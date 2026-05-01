import glob

count = 0
for filepath in glob.glob("/Users/david/.codex/skills/**/SKILL.md", recursive=True):
    with open(filepath, 'r') as f:
        lines = f.readlines()
        
    if not lines: continue
    if not lines[0].startswith('---'): continue
    
    # Check if a closing --- exists
    has_closing = False
    for i in range(1, len(lines)):
        if lines[i].strip() == '---':
            has_closing = True
            break
            
    if has_closing:
        continue
        
    # Find the end of YAML by searching for the first markdown-like line or empty line with markdown next
    yaml_end = -1
    for i in range(1, len(lines)):
        if lines[i].startswith('#') or lines[i].startswith('>') or lines[i].startswith('##'):
            yaml_end = i
            break
            
    if yaml_end != -1:
        # Go back to skip empty lines
        while yaml_end > 1 and lines[yaml_end-1].strip() == '':
            yaml_end -= 1
        
        lines.insert(yaml_end, '---\n\n')
        with open(filepath, 'w') as f:
            f.writelines(lines)
        count += 1

print(f"Fixed {count} files missing closing ---")
