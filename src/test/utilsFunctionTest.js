const path = require('path');
const fs = require('fs');

// Mock the vscode module for testing
const vscode = {
    workspace: {
        workspaceFolders: null
    }
};

// Mock imports for testing in Node.js environment
const crypto = require('crypto');

// Import the utility functions we want to test (simulated)
class TestUtils {
    static escapeRegex(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    static extractNamespace(content) {
        const namespaceMatch = content.match(/^namespace\s+([\w.]+)/m);
        return namespaceMatch ? namespaceMatch[1] : null;
    }

    static extractUsingStatements(content) {
        const lines = content.split('\n');
        const usingStatements = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            const usingMatch = line.match(/^using\s+([\w.]+);/);
            
            if (usingMatch) {
                usingStatements.push({
                    namespace: usingMatch[1],
                    lineNumber: i + 1
                });
            }
        }

        return usingStatements;
    }

    static extractClasses(content) {
        const classes = [];
        const lines = content.split('\n');

        const classPatterns = [
            /(?:public|internal|private|protected)?\s*(?:static\s+)?(?:partial\s+)?(?:abstract\s+)?class\s+(\w+)/,
            /(?:public|internal|private|protected)?\s*(?:static\s+)?(?:partial\s+)?(?:readonly\s+)?struct\s+(\w+)/,
            /(?:public|internal|private|protected)?\s*(?:partial\s+)?interface\s+(\w+)/,
            /(?:public|internal|private|protected)?\s*enum\s+(\w+)/,
        ];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const stripped = line.trim();
            
            if (!stripped || stripped.startsWith('//')) {
                continue;
            }

            for (const pattern of classPatterns) {
                const match = pattern.exec(stripped);
                if (match) {
                    const className = match[1];
                    
                    // Check if this appears to be nested
                    const isNested = this.isClassNested(lines, i, className);
                    
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
                    }
                    break;
                }
            }
        }

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
        
        for (let j = 0; j < classLineIndex; j++) {
            const line = lines[j].trim();
            
            if (line.startsWith('namespace ')) {
                insideNamespace = true;
            }
            
            // Count actual braces, not class declarations
            // Only count braces to determine actual nesting level
            braceBalance += (line.match(/\{/g) || []).length;
            braceBalance -= (line.match(/\}/g) || []).length;
        }
        
        // If we're inside a namespace and the brace balance is 1 (just the namespace),
        // then this class is at the top level within the namespace
        if (insideNamespace && braceBalance <= 1) {
            return false;
        }
        
        // If we're not in a namespace and balance is 0, it's top-level
        if (!insideNamespace && braceBalance === 0) {
            return false;
        }
        
        return braceBalance > 0;
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

    static extractClassScope(lines, className) {
        const classScopeLines = [];
        
        const classPattern = new RegExp(`(?:public|internal|private|protected)?\\s*(?:static\\s+)?(?:partial\\s+)?(?:abstract\\s+)?(?:sealed\\s+)?(?:class|struct)\\s+${this.escapeRegex(className)}(?:\\s*:|<|\\s+|\\s*\\{|\\s*$)`);
        
        let classStartLine = -1;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (classPattern.test(line)) {
                const words = line.split(/\s+/);
                const hasExactClassName = words.some(word => 
                    word === className || 
                    word.startsWith(className + ':') || 
                    word.startsWith(className + '<') || 
                    word.startsWith(className + '{')
                );
                
                if (hasExactClassName) {
                    classStartLine = i;
                    break;
                }
            }
        }

        if (classStartLine === -1) {
            return classScopeLines;
        }

        let braceDepth = 0;
        let hasEnteredClass = false;
        
        for (let i = classStartLine; i < lines.length; i++) {
            const line = lines[i];
            
            for (const char of line) {
                if (char === '{') {
                    if (!hasEnteredClass) {
                        hasEnteredClass = true;
                    }
                    braceDepth++;
                } else if (char === '}') {
                    braceDepth--;
                }
            }
            
            if (hasEnteredClass) {
                classScopeLines.push([i + 1, line]);
                
                if (braceDepth <= 0) {
                    break;
                }
            }
        }

        return classScopeLines;
    }

    static extractQualifiedTypeReferencesEnhanced(content) {
        const lines = content.split('\n');
        const qualifiedRefs = [];
        const pattern = /\b([A-Z][a-zA-Z0-9]*(?:\.[A-Z][a-zA-Z0-9]*)+)\b/g;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            // Skip comments and string literals for qualified type references
            if (line.trim().startsWith('//') || line.trim().startsWith('*') || line.trim().startsWith('/*')) {
                continue;
            }
            
            // Simple string literal detection - skip lines with quoted strings containing class names
            if (/"[^"]*[A-Z][a-zA-Z0-9]*\.[A-Z][a-zA-Z0-9]*[^"]*"/.test(line)) {
                continue;
            }
            
            let match;
            while ((match = pattern.exec(line)) !== null) {
                const qualifiedType = match[1];
                const parts = qualifiedType.split('.');
                if (parts.length >= 2) {
                    const typeName = parts[parts.length - 1];
                    const namespacePart = parts.slice(0, -1).join('.');
                    qualifiedRefs.push({
                        namespace: namespacePart,
                        context: `qualified type reference to ${typeName}`,
                        lineNumber: i + 1
                    });
                }
            }
        }
        
        return qualifiedRefs;
    }

    static findCircularDependencies(dependencies) {
        const visited = new Set();
        const recStack = new Set();
        const cycles = [];
        
        const dfs = (node, path) => {
            if (recStack.has(node)) {
                const cycleStart = path.indexOf(node);
                if (cycleStart !== -1) {
                    const cycle = path.slice(cycleStart).concat([node]);
                    cycles.push(cycle);
                }
                return;
            }
            
            if (visited.has(node)) {
                return;
            }
            
            visited.add(node);
            recStack.add(node);
            
            const dependencyNode = dependencies.get(node);
            if (dependencyNode && dependencyNode.dependencies) {
                for (const neighbor of dependencyNode.dependencies) {
                    dfs(neighbor, [...path, node]);
                }
            }
            
            recStack.delete(node);
        };
        
        for (const node of dependencies.keys()) {
            if (!visited.has(node)) {
                dfs(node, []);
            }
        }
        
        return cycles.map(cycle => ({
            cycle: cycle.slice(0, -1),
            description: cycle.slice(0, -1).join(' → ')
        }));
    }
}

async function runUtilsFunctionTests() {
    console.log('🧪 TESTING EXTRACTED UTILS FUNCTIONS');
    console.log('====================================');
    
    const workspaceRoot = path.resolve(__dirname, '../..');
    console.log(`📁 Workspace: ${workspaceRoot}`);
    
    let allTestsPassed = true;
    
    try {
        // Test 1: extractNamespace function
        console.log('\n📋 Test 1: extractNamespace function');
        const testCode1 = `using System;
namespace TestScenarios.FalsePositiveTest
{
    public class TestClass
    {
    }
}`;
        const namespace1 = TestUtils.extractNamespace(testCode1);
        if (namespace1 === 'TestScenarios.FalsePositiveTest') {
            console.log('✅ extractNamespace works correctly');
        } else {
            console.log(`❌ extractNamespace failed. Expected: 'TestScenarios.FalsePositiveTest', Got: '${namespace1}'`);
            allTestsPassed = false;
        }

        // Test 2: extractUsingStatements function
        console.log('\n📋 Test 2: extractUsingStatements function');
        const testCode2 = `using System;
using System.Collections.Generic;
using Unity.Engine;

namespace Test {`;
        const usings = TestUtils.extractUsingStatements(testCode2);
        if (usings.length === 3 && usings[0].namespace === 'System' && usings[1].namespace === 'System.Collections.Generic') {
            console.log('✅ extractUsingStatements works correctly');
        } else {
            console.log(`❌ extractUsingStatements failed. Expected 3 usings, got ${usings.length}`);
            allTestsPassed = false;
        }

        // Test 3: extractClasses function
        console.log('\n📋 Test 3: extractClasses function');
        const testCode3 = `namespace TestNamespace
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
        const classes = TestUtils.extractClasses(testCode3);
        if (classes.length === 3) {
            const classTypes = classes.map(c => c.classType).sort();
            if (classTypes.join(',') === 'class,enum,struct') {
                console.log('✅ extractClasses works correctly');
            } else {
                console.log(`❌ extractClasses class types failed. Expected: 'class,enum,struct', Got: '${classTypes.join(',')}'`);
                allTestsPassed = false;
            }
        } else {
            console.log(`❌ extractClasses failed. Expected 3 classes, got ${classes.length}`);
            allTestsPassed = false;
        }

        // Test 4: extractQualifiedTypeReferencesEnhanced function
        console.log('\n📋 Test 4: extractQualifiedTypeReferencesEnhanced function');
        const testCode4 = `using System;

namespace Test
{
    public class TestClass
    {
        public Combat.FindTargetSystem finder;
        private Movement.ShipMover mover;
        // This comment contains Combat.Something but should be ignored
        public string message = "Combat.InString should be ignored";
    }
}`;
        const qualifiedRefs = TestUtils.extractQualifiedTypeReferencesEnhanced(testCode4);
        if (qualifiedRefs.length === 2) {
            const namespaces = qualifiedRefs.map(r => r.namespace).sort();
            if (namespaces.join(',') === 'Combat,Movement') {
                console.log('✅ extractQualifiedTypeReferencesEnhanced works correctly');
            } else {
                console.log(`❌ extractQualifiedTypeReferencesEnhanced namespaces failed. Expected: 'Combat,Movement', Got: '${namespaces.join(',')}'`);
                allTestsPassed = false;
            }
        } else {
            console.log(`❌ extractQualifiedTypeReferencesEnhanced failed. Expected 2 references, got ${qualifiedRefs.length}`);
            console.log('Found references:', qualifiedRefs);
            allTestsPassed = false;
        }

        // Test 5: findCircularDependencies function
        console.log('\n📋 Test 5: findCircularDependencies function');
        const testDependencies = new Map();
        testDependencies.set('A', { dependencies: ['B'] });
        testDependencies.set('B', { dependencies: ['C'] });
        testDependencies.set('C', { dependencies: ['A'] });
        testDependencies.set('D', { dependencies: [] });

        const circularDeps = TestUtils.findCircularDependencies(testDependencies);
        if (circularDeps.length === 1 && circularDeps[0].cycle.length === 3) {
            console.log('✅ findCircularDependencies works correctly');
        } else {
            console.log(`❌ findCircularDependencies failed. Expected 1 cycle with 3 nodes, got ${circularDeps.length} cycles`);
            console.log('Found cycles:', circularDeps);
            allTestsPassed = false;
        }

        // Test 6: Test with real files from test scenarios
        console.log('\n📋 Test 6: Real file analysis');
        const falsePositiveTestPath = path.join(workspaceRoot, 'src/test/Scripts/TestScenarios/FalsePositiveTest/IndependentServiceA.cs');
        
        if (fs.existsSync(falsePositiveTestPath)) {
            const fileContent = fs.readFileSync(falsePositiveTestPath, 'utf8');
            const namespace = TestUtils.extractNamespace(fileContent);
            const classes = TestUtils.extractClasses(fileContent);
            
            if (namespace && namespace.includes('TestScenarios.FalsePositiveTest')) {
                console.log('✅ Real file namespace extraction works');
            } else {
                console.log(`❌ Real file namespace failed. Got: '${namespace}'`);
                allTestsPassed = false;
            }
            
            if (classes.length > 0) {
                console.log('✅ Real file class extraction works');
            } else {
                console.log('❌ Real file class extraction failed - no classes found');
                allTestsPassed = false;
            }
        } else {
            console.log('⚠️ Test file not found, skipping real file test');
        }

        console.log('\n📊 UTILS FUNCTION TEST RESULTS');
        console.log('==============================');
        
        if (allTestsPassed) {
            console.log('🎉 ALL UTILS FUNCTION TESTS PASSED!');
            console.log('   ✅ All extracted functions work correctly');
            console.log('   ✅ Ready for integration with main codebase');
            return true;
        } else {
            console.log('🚨 SOME UTILS FUNCTION TESTS FAILED!');
            console.log('   The extracted functions need fixes before integration.');
            return false;
        }
        
    } catch (error) {
        console.error('💥 ERROR during utils function testing:', error);
        return false;
    }
}

// Run the utils function tests
runUtilsFunctionTests().then(success => {
    process.exit(success ? 0 : 1);
}).catch(error => {
    console.error('💥 FATAL ERROR:', error);
    process.exit(1);
});