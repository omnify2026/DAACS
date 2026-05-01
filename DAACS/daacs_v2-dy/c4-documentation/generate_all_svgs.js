const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const exportsDir = path.join(__dirname, 'drawio_exports');

if (!fs.existsSync(exportsDir)) {
    console.error(`Directory not found: ${exportsDir}`);
    process.exit(1);
}

const files = fs.readdirSync(exportsDir).filter(file => file.endsWith('.mermaid'));

console.log(`Found ${files.length} mermaid files to convert.`);

files.forEach(file => {
    const inputPath = path.join(exportsDir, file);
    const outputFilename = file.replace('.mermaid', '.svg');
    const outputPath = path.join(exportsDir, outputFilename);

    if (fs.existsSync(outputPath)) {
        console.log(`Skipping ${file} - SVG already exists.`);
        return;
    }

    console.log(`Converting ${file} -> ${outputFilename}...`);
    try {
        // Use npx to run mmdc. Note: absolute paths in args for safety
        // Adding -p @mermaid-js/mermaid-cli ensured package is available
        execSync(`npx -p @mermaid-js/mermaid-cli mmdc -i "${inputPath}" -o "${outputPath}" -b transparent`, { stdio: 'inherit' });
    } catch (error) {
        console.error(`Failed to convert ${file}:`, error.message);
    }
});

console.log('Batch conversion complete.');
