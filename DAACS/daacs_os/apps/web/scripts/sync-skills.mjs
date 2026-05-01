import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths relative to DAACS/DAACS_OS/apps/web/scripts
const CLI_SKILLS_PATH = path.resolve(__dirname, '../../../../CLI/daacs-cli/.claude/skills');
const DEST_SKILLS_PATH = path.resolve(__dirname, '../../../desktop/Resources/skills/repository');

function copyFolderRecursiveSync(source, target) {
    if (!fs.existsSync(target)) {
        fs.mkdirSync(target, { recursive: true });
    }
    const files = fs.readdirSync(source);
    files.forEach((file) => {
        const curSource = path.join(source, file);
        const curTarget = path.join(target, file);
        if (fs.lstatSync(curSource).isDirectory()) {
            copyFolderRecursiveSync(curSource, curTarget);
        } else {
            fs.copyFileSync(curSource, curTarget);
        }
    });
}

try {
    if (fs.existsSync(CLI_SKILLS_PATH)) {
        console.log(`Syncing skills from ${CLI_SKILLS_PATH} to ${DEST_SKILLS_PATH}...`);
        copyFolderRecursiveSync(CLI_SKILLS_PATH, DEST_SKILLS_PATH);
        console.log("Skill sync completed successfully.");
    } else {
        console.warn(`Source CLI skills path not found: ${CLI_SKILLS_PATH}`);
    }
} catch (e) {
    console.error("Failed to sync skills:", e);
    process.exit(1);
}
