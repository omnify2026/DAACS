import glob
import yaml
import sys

count = 0
for filepath in glob.glob("/Users/david/.codex/skills/**/SKILL.md", recursive=True):
    with open(filepath, 'r') as f:
        lines = f.readlines()
        
    if not lines or not lines[0].startswith('---'): continue
    
    # strip trailing newlines for easier processing
    lines = [l.rstrip('\n') for l in lines]
    
    end_idx = -1
    for i in range(1, len(lines)):
        if lines[i].strip() == '---':
            end_idx = i
            break
            
    if end_idx == -1: continue # Should be handled by previous script
    
    # Try to parse
    frontmatter = '\n'.join(lines[1:end_idx])
    try:
        list(yaml.safe_load_all(frontmatter))
        continue # It parsed successfully!
    except Exception as e:
        # It's malformed. Let's find the first empty line or first line that breaks parsing
        # and insert --- there, replacing the old ---
        pass
        
    # How to fix: 
    # Valid YAML top level keys look like `key: value`
    # Let's find the last valid key
    valid_yaml_lines = []
    rest_lines = []
    
    in_yaml = True
    seen_keys = set()
    
    for i in range(1, end_idx):
        line = lines[i]
        
        # If it's an empty line, usually separates valid YAML from invalid markdown in these buggy files
        if line.strip() == '':
            # check if next non empty line looks like a valid key
            looks_valid = False
            for j in range(i+1, end_idx):
                next_l = lines[j]
                if next_l.strip():
                    if ':' in next_l or next_l.startswith('- '):
                        looks_valid = True
                    break
            if not looks_valid:
                in_yaml = False
                
        if not in_yaml:
            rest_lines.append(line)
            continue
            
        # Duplicates filtering
        if ':' in line and not line.startswith(' ') and not line.startswith('-'):
            k = line.split(':', 1)[0].strip()
            if k in seen_keys:
                continue # skip duplicate
            seen_keys.add(k)
        
        # if the line starts with ** or letters without :, it's markdown
        if line.startswith('*') or line.startswith('#'):
            in_yaml = False
            rest_lines.append(line)
            continue
            
        if line.strip() != '' and not line.startswith(' ') and not line.startswith('-') and ':' not in line:
            in_yaml = False
            rest_lines.append(line)
            continue
            
        valid_yaml_lines.append(line)
        
    new_content = ['---'] + valid_yaml_lines + ['---'] + rest_lines + lines[end_idx+1:]
    
    # try parsing valid_yaml_lines to be strict
    try:
        yaml.safe_load('\n'.join(valid_yaml_lines))
        with open(filepath, 'w') as f:
            f.write('\n'.join(new_content) + '\n')
        count += 1
    except:
        # STILL fails?
        pass

print(f"Fixed {count} files")
