const path = require('path');

// Debug version of extractClasses function
class TestUtils {
    static escapeRegex(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    static extractClasses(content) {
        const classes = [];
        const lines = content.split('\n');

        console.log(`Total lines: ${lines.length}`);
        console.log('Content:');
        lines.forEach((line, i) => console.log(`${i+1}: "${line}"`));

        const classPatterns = [
            /(?:public|internal|private|protected)?\s*(?:static\s+)?(?:partial\s+)?(?:abstract\s+)?class\s+(\w+)/,
            /(?:public|internal|private|protected)?\s*(?:static\s+)?(?:partial\s+)?(?:readonly\s+)?struct\s+(\w+)/,
            /(?:public|internal|private|protected)?\s*(?:partial\s+)?interface\s+(\w+)/,
            /(?:public|internal|private|protected)?\s*enum\s+(\w+)/,
        ];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const stripped = line.trim();
            
            console.log(`\nLine ${i+1}: "${stripped}"`);
            
            if (!stripped || stripped.startsWith('//')) {
                console.log('  -> Skipped (empty or comment)');
                continue;
            }

            for (const pattern of classPatterns) {
                const match = pattern.exec(stripped);
                if (match) {
                    const className = match[1];
                    console.log(`  -> MATCH found: ${className}`);
                    
                    // Check if this appears to be nested
                    const isNested = this.isClassNested(lines, i, className);
                    console.log(`  -> isNested: ${isNested}`);
                    
                    if (!isNested) {
                        classes.push({
                            name: className,
                            fullName: className,
                            namespace: '',
                            isNested: false,
                            startLine: i + 1,
                            endLine: this.findClassEndLine(lines, i),
                            classType: this.determineClassType(stripped)
                        });
                        console.log(`  -> ADDED class: ${className}`);
                    } else {
                        console.log(`  -> SKIPPED (nested): ${className}`);
                    }
                    break;
                }
            }
        }

        console.log(`\nFinal classes found: ${classes.length}`);
        classes.forEach(c => console.log(`  - ${c.name} (${c.classType})`));

        return classes;
    }

    static determineClassType(line) {
        if (line.includes('struct')) return 'struct';
        if (line.includes('interface')) return 'interface';
        if (line.includes('enum')) return 'enum';
        return 'class';
    }

    static isClassNested(lines, classLineIndex, className) {
        let braceBalance = 0;
        let insideNamespace = false;
        
        console.log(`    Checking if ${className} is nested (line ${classLineIndex + 1}):`);
        
        for (let j = 0; j < classLineIndex; j++) {
            const line = lines[j].trim();
            
            if (line.startsWith('namespace ')) {
                insideNamespace = true;
                console.log(`    Line ${j+1}: Found namespace, insideNamespace = true`);
            }
            
            if (/(?:class|struct|interface|enum)\s+\w+/.test(line)) {
                braceBalance += 1;
                console.log(`    Line ${j+1}: Found class declaration, braceBalance = ${braceBalance}`);
            }
            
            const openBraces = (line.match(/\{/g) || []).length;
            const closeBraces = (line.match(/\}/g) || []).length;
            braceBalance += openBraces - closeBraces;
            
            if (openBraces > 0 || closeBraces > 0) {
                console.log(`    Line ${j+1}: Braces: +${openBraces} -${closeBraces}, balance = ${braceBalance}`);
            }
        }
        
        console.log(`    Final: insideNamespace=${insideNamespace}, braceBalance=${braceBalance}`);
        
        if (insideNamespace && braceBalance <= 1) {
            console.log(`    -> NOT nested (inside namespace and balance <= 1)`);
            return false;
        }
        
        const isNested = braceBalance > 0;
        console.log(`    -> ${isNested ? 'NESTED' : 'NOT nested'} (balance > 0)`);
        return isNested;
    }

    static findClassEndLine(lines, startLine) {
        let braceCount = 0;
        let inClass = false;

        for (let i = startLine; i < lines.length; i++) {
            const line = lines[i];

            if (line.includes('{')) {
                braceCount += (line.match(/\{/g) || []).length;
                inClass = true;
            }

            if (line.includes('}')) {
                braceCount -= (line.match(/\}/g) || []).length;
            }

            if (inClass && braceCount <= 0) {
                return i + 1;
            }
        }

        return lines.length;
    }
}

// Test the problematic case
console.log('🔍 DEBUGGING CLASS EXTRACTION');
console.log('=============================');

const testCode = `namespace TestNamespace
{
    public class TestClass
    {
        public int Value { get; set; }
    }
    
    public struct TestStruct
    {
        public string Name;
    }
    
    public enum TestEnum
    {
        Value1, Value2
    }
}`;

console.log('Test code analysis:');
const classes = TestUtils.extractClasses(testCode);

console.log('\n📊 RESULTS:');
console.log(`Expected: 3 classes`);
console.log(`Found: ${classes.length} classes`);

if (classes.length === 3) {
    console.log('✅ Test PASSED');
} else {
    console.log('❌ Test FAILED');
}