console.log('Testing class extraction directly...');
const fs = require('fs');
const path = require('path');

const gameConstantsPath = path.join(__dirname, 'Scripts/Core/GameConstants.cs');
const content = fs.readFileSync(gameConstantsPath, 'utf8');
console.log('GameConstants.cs content:');
console.log(content);
console.log('\n--- Testing extractClasses function ---');

function extractClasses(content) {
    const classes = [];
    const lines = content.split('\n');
    console.log(`Total lines: ${lines.length}`);

    const classPatterns = [
        /(?:public|internal|private|protected)?\s*(?:static\s+)?(?:partial\s+)?(?:abstract\s+)?class\s+(\w+)/,
        /(?:public|internal|private|protected)?\s*(?:static\s+)?(?:partial\s+)?(?:readonly\s+)?struct\s+(\w+)/,
        /(?:public|internal|private|protected)?\s*(?:partial\s+)?interface\s+(\w+)/,
        /(?:public|internal|private|protected)?\s*enum\s+(\w+)/,
    ];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const stripped = line.trim();
        console.log(`Line ${i+1}: "${stripped}"`);
        
        if (!stripped || stripped.startsWith('//')) {
            continue;
        }

        for (const pattern of classPatterns) {
            const match = pattern.exec(stripped);
            if (match) {
                console.log(`✅ Found class: ${match[1]} at line ${i+1}`);
                classes.push({ name: match[1], line: i+1 });
                break;
            }
        }
    }
    
    return classes;
}

const foundClasses = extractClasses(content);
console.log(`\nExtracted classes: ${JSON.stringify(foundClasses, null, 2)}`);