const path = require('path');
const fs = require('fs');

console.log('🔍 Debug Test Starting...');

const workspaceRoot = path.resolve(__dirname, '../..');
console.log(`📁 Workspace: ${workspaceRoot}`);

const scriptsPath = path.join(workspaceRoot, 'src/test/Scripts');
console.log(`📂 Scripts path: ${scriptsPath}`);
console.log(`📂 Scripts exists: ${fs.existsSync(scriptsPath)}`);

if (fs.existsSync(scriptsPath)) {
    const entries = fs.readdirSync(scriptsPath, { withFileTypes: true });
    console.log(`📂 Found ${entries.length} entries in Scripts directory:`);
    
    for (const entry of entries.slice(0, 10)) { // Limit to first 10 entries
        console.log(`   ${entry.isDirectory() ? '📁' : '📄'} ${entry.name}`);
        
        if (entry.isDirectory() && entry.name === 'Core') {
            const corePath = path.join(scriptsPath, 'Core');
            const coreEntries = fs.readdirSync(corePath, { withFileTypes: true });
            console.log(`   📁 Core directory contains ${coreEntries.length} files:`);
            for (const coreEntry of coreEntries) {
                console.log(`      📄 ${coreEntry.name}`);
            }
        }
    }
} else {
    console.log('❌ Scripts directory does not exist!');
}

console.log('✅ Debug test completed.');