const fs = require('fs');
const path = require('path');

const inputDir = __dirname;
const outputDir = path.join(inputDir, 'drawio_exports');

if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir);
}

// Function to escape XML special characters AND newlines
function escapeXml(unsafe) {
    return unsafe.replace(/[<>&'"\n\r]/g, function (c) {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
            case '\n': return '&#xa;';
            case '\r': return '';
        }
    });
}

function createDrawioXml(mermaidCode) {
    const escapedCode = escapeXml(mermaidCode.trim());
    return `<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="app.diagrams.net" type="device">
  <diagram id="mermaid-diagram" name="Mermaid Diagram">
    <mxGraphModel dx="1000" dy="1000" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="2" value="${escapedCode}" style="shape=mxgraph.mermaid;html=1;whiteSpace=wrap;" parent="1" vertex="1">
          <mxGeometry x="40" y="40" width="800" height="600" as="geometry" />
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;
}

fs.readdir(inputDir, (err, files) => {
    if (err) {
        console.error('Error reading directory:', err);
        return;
    }

    files.forEach(file => {
        if (path.extname(file) === '.md') {
            const filePath = path.join(inputDir, file);
            const content = fs.readFileSync(filePath, 'utf8');

            // Regex to find mermaid blocks
            const mermaidRegex = /```mermaid([\s\S]*?)```/g;
            let match;
            let count = 1;

            while ((match = mermaidRegex.exec(content)) !== null) {
                const mermaidCode = match[1];
                if (mermaidCode) {
                    const baseName = path.basename(file, '.md');
                    const outputFilename = `${baseName}_diagram_${count}.drawio`;
                    const mermaidFilename = `${baseName}_diagram_${count}.mermaid`;
                    const outputPath = path.join(outputDir, outputFilename);
                    const mermaidPath = path.join(outputDir, mermaidFilename);

                    const xmlContent = createDrawioXml(mermaidCode);

                    fs.writeFileSync(outputPath, xmlContent);
                    fs.writeFileSync(mermaidPath, mermaidCode.trim());
                    console.log(`Created: ${outputFilename} and ${mermaidFilename}`);
                    count++;
                }
            }
        }
    });
});
