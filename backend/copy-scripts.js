const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'src', 'scripts');
const destDir = path.join(__dirname, 'dist', 'scripts');

if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
}

fs.readdirSync(srcDir).forEach(file => {
    if (file.endsWith('.py')) {
        fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
        console.log(`Copied ${file} to dist/scripts`);
    }
});
