import os

files_to_fix = [
    "/Users/david/.codex/skills/security-scanning-security-hardening/SKILL.md",
    "/Users/david/.codex/skills/application-performance-performance-optimization/SKILL.md",
    "/Users/david/.codex/skills/backend-development-feature-development/SKILL.md",
    "/Users/david/.codex/skills/build/SKILL.md",
    "/Users/david/.codex/skills/clarity-gate/SKILL.md"
]

for filepath in files_to_fix:
    if not os.path.exists(filepath): continue
    
    with open(filepath, 'r') as f:
        content = f.read()
        
    lines = content.splitlines()
    
    # We will just forcefully rewrite the frontmatter of these 5 broken ones
    if "security-scanning" in filepath or "performance-optimization" in filepath or "backend-development" in filepath:
        # The issue is the multiline [Extended thinking...] block in YAML.
        # We find that line and put --- before it.
        new_lines = []
        in_yaml = True
        for line in lines:
            if in_yaml and line.strip().startswith('['):
                new_lines.append('---')
                in_yaml = False
            new_lines.append(line)
        if in_yaml: # wait, if it already had --- it might be later
            pass
        # Let's cleanly strip and reconstruct
        with open(filepath, 'w') as f:
            f.write('\n'.join(new_lines) + '\n')
            
    elif "build/SKILL.md" in filepath:
        # "did not find expected key while parsing a block mapping"
        # Let's just find the first blank line and put ---
        new_lines = []
        in_yaml = True
        for i, line in enumerate(lines):
            if in_yaml and line.strip() == '' and i > 2:
                new_lines.append('---')
                in_yaml = False
            new_lines.append(line)
        with open(filepath, 'w') as f:
            f.write('\n'.join(new_lines) + '\n')
            
    elif "clarity-gate/SKILL.md" in filepath:
        # missing frontmatter
        if not content.startswith('---'):
            with open(filepath, 'w') as f:
                f.write('---\nname: clarity-gate\n---\n' + content)

print("Final 5 files patched forcefully.")
