import glob

count = 0
for filepath in glob.glob("/Users/david/.codex/skills/**/SKILL.md", recursive=True):
    with open(filepath, 'r') as f:
        content = f.read()
    
    if content.startswith('---'):
        lines = content.splitlines()
        
        new_lines = [lines[0]]
        in_yaml = True
        
        for i in range(1, len(lines)):
            line = lines[i]
            
            if in_yaml:
                # To be robust, if we hit any markdown # or >, we force end YAML
                # Check next non-empty line
                is_markdown_border = False
                if line.strip() == '':
                    for j in range(i+1, len(lines)):
                        if lines[j].strip() != '':
                            if lines[j].startswith('#') or lines[j].startswith('>'):
                                is_markdown_border = True
                            break
                            
                if line.startswith('#') or line.startswith('>') or is_markdown_border:
                    if line.strip() != '': 
                        # This line itself is a heading or quote
                        new_lines.append('---')
                        new_lines.append('')
                        new_lines.append(line)
                    else:
                        new_lines.append('---')
                        new_lines.append(line)
                    in_yaml = False
                    continue
                
                if line.strip() == '---':
                    continue
                    
                new_lines.append(line)
            else:
                new_lines.append(line)
                
        # Now scrub duplicate names/descriptions inside the top frontmatter block
        # We find the end of yaml
        yaml_lines = []
        md_lines = []
        is_yaml = True
        for line in new_lines:
            if is_yaml:
                yaml_lines.append(line)
                if len(yaml_lines) > 1 and line == '---':
                    is_yaml = False
            else:
                md_lines.append(line)
                
        # filter duplicates
        keys_seen = set()
        cleaned_yaml = []
        for yl in yaml_lines:
            if ':' in yl and not yl.startswith(' '):
                parts = yl.split(':', 1)
                k = parts[0].strip()
                if k in keys_seen:
                    continue
                else:
                    keys_seen.add(k)
            cleaned_yaml.append(yl)
            
        final_content = '\n'.join(cleaned_yaml + md_lines) + '\n'
        
        # fix double tool arrays
        if 'tools: [claude, cursor,antigravity]' in final_content and 'tools:' in final_content:
             pass # Set should have handled it if they were distinct lines
             
        with open(filepath, 'w') as f:
            f.write(final_content)
        count += 1

print(f"Fixed {count} files")
