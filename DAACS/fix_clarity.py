filepath = "/Users/david/.codex/skills/clarity-gate/SKILL.md"
with open(filepath, 'r') as f:
    lines = f.readlines()

new_lines = []
in_frontmatter = False
for i, line in enumerate(lines):
    if i == 0 and line.strip() == '---':
        pass
    elif i == 1 and line.strip() == '---':
        pass 
    elif i == 2 and line.strip() == '':
        pass
    elif i == 3 and line.strip() == '# agentskills.io compliant frontmatter':
        pass
    else:
        new_lines.append(line)

final = ["---", "# agentskills.io compliant frontmatter"] + new_lines
# need to insert --- after Outputs: list
insert_dash_idx = -1
for i, line in enumerate(final):
    if "outputs:" in line:
        pass
    if "  - type: cgd" in line:
        # After this, the markdown content begins (like `# Clarity Gate Protocol`)
        # actually let's just find the first markdown header after outputs
        # or just insert --- right after it
        pass

# Let's just do it manually with a regex
import re
with open(filepath, 'r') as f:
    content = f.read()
    
# Remove all ---
clean_content = content.replace('---\n', '')
clean_content = clean_content.replace('---', '')

# Assume the yaml ends tightly after `outputs: \n  - type: cgd\n`
with open(filepath, 'w') as f:
    f.write('---\n' + clean_content.replace('  - type: cgd\n', '  - type: cgd\n---\n', 1))

