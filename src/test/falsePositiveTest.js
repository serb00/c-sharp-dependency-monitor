const path = require('path');
const fs = require('fs');

class StandaloneDependencyAnalyzer {
    constructor(outputChannel) {
        this.outputChannel = outputChannel || {
            appendLine: (message) => console.log(message)
        };
        this.dependencyPatterns = [
            { pattern: /:\s*CLASSNAME/, description: 'inheritance', weight: 10 },
            { pattern: /:\s*.*,\s*CLASSNAME/, description: 'interface implementation', weight: 9 },
            { pattern: /(?:public|private|protected|internal)\s+CLASSNAME\s+\w+/, description: 'field declaration', weight: 8 },
            { pattern: /<CLASSNAME>/, description: 'generic type parameter', weight: 7 },
            { pattern: /new\s+CLASSNAME\s*[\(\{]/, description: 'object instantiation', weight: 6 },
            { pattern: /CLASSNAME\.\w+/, description: 'static member access', weight: 5 },
            { pattern: /\bCLASSNAME\b/, description: 'general reference', weight: 3 }
        ];
    }

    log(message) {
        this.outputChannel.appendLine(message);
    }

    async analyzeClassDependencies(workspaceRoot) {
        const dependencies = new Map();
        const allFiles = await this.getAllCSharpFiles(workspaceRoot);
        const allClasses = new Map();

        // First pass: collect all classes
        for (const filePath of allFiles) {
            try {
                const content = fs.readFileSync(filePath, 'utf8');
                const namespace = this.extractNamespace(content) || 'Global';
                const classes = this.extractClasses(content);

                for (const classInfo of classes) {
                    if (!classInfo.isNested) {
                        const fullClassName = `${namespace}.${classInfo.name}`;
                        allClasses.set(classInfo.name, {
                            namespace,
                            fullName: fullClassName,
                            filePath
                        });
                    }
                }
            } catch (error) {
                this.log(`Error analyzing file ${filePath}: ${error}`);
            }
        }

        // Second pass: find dependencies
        for (const filePath of allFiles) {
            try {
                const content = fs.readFileSync(filePath, 'utf8');
                const namespace = this.extractNamespace(content) || 'Global';
                const usingStatements = this.extractUsingStatements(content);
                const customUsings = usingStatements
                    .filter(u => !this.shouldIgnoreNamespace(u.namespace))
                    .map(u => u.namespace);

                const currentFileClasses = this.extractClasses(content)
                    .filter(c => !c.isNested)
                    .map(c => ({
                        name: c.name,
                        fullName: `${namespace}.${c.name}`,
                        classInfo: c
                    }));

                // For each class in this file, find its dependencies
                for (const { name: className, fullName: fullClassName, classInfo } of currentFileClasses) {
                    const classDeps = [];
                    const classDepDetails = new Map();

                    // Extract the specific scope of this class
                    const lines = content.split('\n');
                    const classScopeLines = this.extractClassScope(lines, className);

                    // Process qualified type references in class scope (e.g., Combat.FindTargetSystem)
                    const classScopeContent = classScopeLines.map(([_, line]) => line).join('\n');
                    const qualifiedTypeRefs = this.extractQualifiedTypeReferences(classScopeContent);
                    
                    for (const typeRef of qualifiedTypeRefs) {
                        const targetNamespace = typeRef.namespace;
                        const typeName = typeRef.context.replace('qualified type reference to ', '');
                        const fullTargetClass = `${targetNamespace}.${typeName}`;
                        
                        // Check if this qualified reference points to a known class by full name
                        for (const [className, classInfo] of allClasses) {
                            if (classInfo.fullName === fullTargetClass && classInfo.fullName !== fullClassName) {
                                classDeps.push(classInfo.fullName);
                                const relativePath = path.relative(workspaceRoot, filePath);
                                if (!classDepDetails.has(classInfo.fullName)) {
                                    classDepDetails.set(classInfo.fullName, []);
                                }
                                classDepDetails.get(classInfo.fullName).push(`qualified type reference to ${typeName} (${relativePath}:${typeRef.lineNumber})`);
                                break;
                            }
                        }
                    }

                    // Look for references to other classes
                    for (const [otherClassName, otherClassInfo] of allClasses) {
                        if (otherClassInfo.fullName === fullClassName) {
                            continue; // Skip self-reference
                        }

                        // Check namespace availability
                        if (!(otherClassInfo.namespace === namespace ||
                              customUsings.includes(otherClassInfo.namespace) ||
                              otherClassInfo.namespace === 'Global')) {
                            continue;
                        }

                        // Check for legitimate class usage patterns
                        const foundReferences = this.findClassReferences(
                            classScopeLines, 
                            otherClassName, 
                            filePath,
                            workspaceRoot
                        );

                        if (foundReferences.length > 0) {
                            classDeps.push(otherClassInfo.fullName);
                            classDepDetails.set(otherClassInfo.fullName, foundReferences);
                        }
                    }

                    // Add ALL classes to dependencies map
                    const dependencyDetails = [];
                    for (const [target, reasons] of classDepDetails) {
                        dependencyDetails.push({
                            target,
                            reasons,
                            lineNumbers: reasons.map(r => {
                                const match = r.match(/:(\d+)\)/);
                                return match ? parseInt(match[1]) : 0;
                            })
                        });
                    }

                    dependencies.set(fullClassName, {
                        name: className,
                        namespace,
                        fullName: fullClassName,
                        filePath,
                        dependencies: [...new Set(classDeps)],
                        dependencyDetails,
                        classType: classInfo.classType
                    });
                }
            } catch (error) {
                this.log(`Error analyzing file ${filePath}: ${error}`);
            }
        }

        return dependencies;
    }

    async getAllCSharpFiles(workspaceRoot) {
        const allFiles = [];
        const scriptsPath = path.join(workspaceRoot, 'src/test/Scripts');
        
        try {
            this.walkDirectorySync(scriptsPath, allFiles);
        } catch (error) {
            this.log(`Error scanning directory: ${error}`);
        }

        return allFiles.filter(file => file.endsWith('.cs') && !file.endsWith('.meta'));
    }

    walkDirectorySync(dir, files) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                this.walkDirectorySync(fullPath, files);
            } else if (entry.isFile() && entry.name.endsWith('.cs')) {
                files.push(fullPath);
            }
        }
    }

    extractNamespace(content) {
        const namespaceMatch = content.match(/namespace\s+([^\s\{]+)/);
        return namespaceMatch ? namespaceMatch[1] : null;
    }

    extractUsingStatements(content) {
        const lines = content.split('\n');
        const usingStatements = [];
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            const match = line.match(/^using\s+([^;]+);/);
            if (match) {
                usingStatements.push({
                    namespace: match[1].trim(),
                    lineNumber: i + 1
                });
            }
        }
        
        return usingStatements;
    }

    extractQualifiedTypeReferences(content) {
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

    shouldIgnoreNamespace(namespace) {
        const ignoredNamespaces = ['System', 'Unity', 'UnityEngine'];
        return ignoredNamespaces.some(ignored => namespace.startsWith(ignored));
    }

    extractClasses(content) {
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

    determineClassType(line) {
        if (line.includes('struct')) return 'struct';
        if (line.includes('interface')) return 'interface';
        if (line.includes('enum')) return 'enum';
        return 'class';
    }

    isClassNested(lines, classLineIndex, className) {
        let braceBalance = 0;
        let insideNamespace = false;
        
        for (let j = 0; j < classLineIndex; j++) {
            const line = lines[j].trim();
            
            if (line.startsWith('namespace ')) {
                insideNamespace = true;
            }
            
            if (/(?:class|struct|interface|enum)\s+\w+/.test(line)) {
                braceBalance += 1;
            }
            
            braceBalance += (line.match(/\{/g) || []).length;
            braceBalance -= (line.match(/\}/g) || []).length;
        }
        
        if (insideNamespace && braceBalance <= 1) {
            return false;
        }
        
        return braceBalance > 0;
    }

    findClassEndLine(lines, startLine) {
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

    extractClassScope(lines, className) {
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

    findClassReferences(classScopeLines, otherClassName, filePath, workspaceRoot) {
        const references = [];
        const relativePath = path.relative(workspaceRoot, filePath);

        for (const [lineNumber, lineContent] of classScopeLines) {
            // Skip comments and string literals for dependency detection
            const trimmedLine = lineContent.trim();
            
            // Skip comment lines
            if (trimmedLine.startsWith('//') || trimmedLine.startsWith('*') || trimmedLine.startsWith('/*')) {
                continue;
            }
            
            // Skip string literals containing class names - improved regex
            if (new RegExp(`"[^"]*\\b${this.escapeRegex(otherClassName)}\\b[^"]*"`).test(lineContent)) {
                continue;
            }
            
            for (const pattern of this.dependencyPatterns) {
                const regex = new RegExp(pattern.pattern.source.replace(/CLASSNAME/g, this.escapeRegex(otherClassName)));
                if (regex.test(lineContent)) {
                    references.push(`${pattern.description} (${relativePath}:${lineNumber})`);
                    break;
                }
            }
        }

        return references;
    }

    escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}

class SimpleCircularDetector {
    findCircularDependencies(dependencies) {
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
            if (dependencyNode) {
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

async function runFalsePositiveTest() {
    console.log('🔍 FALSE POSITIVE DETECTION TEST');
    console.log('================================');
    
    const workspaceRoot = path.resolve(__dirname, '../..');
    console.log(`📁 Workspace: ${workspaceRoot}`);
    
    const analyzer = new StandaloneDependencyAnalyzer({
        appendLine: (message) => {} // Silent analyzer for cleaner output
    });
    
    const circularDetector = new SimpleCircularDetector();
    
    try {
        console.log('\n🔍 Analyzing dependencies for false positive detection...');
        const dependencies = await analyzer.analyzeClassDependencies(workspaceRoot);
        
        // Filter only false positive test classes
        const falsePositiveClasses = new Map();
        for (const [fullName, node] of dependencies) {
            if (fullName.includes('TestScenarios.FalsePositiveTest')) {
                falsePositiveClasses.set(fullName, node);
            }
        }
        
        console.log(`📦 False Positive Test Classes: ${falsePositiveClasses.size}`);
        for (const [fullName, node] of falsePositiveClasses) {
            console.log(`   - ${fullName} (${node.dependencies.length} deps)`);
            if (node.dependencies.length > 0) {
                console.log(`     Dependencies: [${node.dependencies.join(', ')}]`);
                // Show detailed reasons for dependencies
                for (const detail of node.dependencyDetails) {
                    console.log(`       → ${detail.target}:`);
                    for (const reason of detail.reasons) {
                        console.log(`         - ${reason}`);
                    }
                }
            }
        }
        
        console.log('\n🔍 Detecting circular dependencies in false positive test scenarios...');
        const circularDeps = circularDetector.findCircularDependencies(falsePositiveClasses);
        
        console.log(`🔄 Found ${circularDeps.length} circular dependencies in false positive tests:`);
        if (circularDeps.length > 0) {
            for (const circular of circularDeps) {
                console.log(`   - ${circular.description}`);
            }
        }
        
        // Test specific expectations
        console.log('\n📊 FALSE POSITIVE ANALYSIS');
        console.log('=========================');
        
        let testsPassed = true;
        
        // Test 1: IndependentServiceA and IndependentServiceB should NOT be connected
        const serviceA = falsePositiveClasses.get('TestScenarios.FalsePositiveTest.IndependentServiceA');
        const serviceB = falsePositiveClasses.get('TestScenarios.FalsePositiveTest.IndependentServiceB');
        
        if (serviceA && serviceA.dependencies.includes('TestScenarios.FalsePositiveTest.IndependentServiceB')) {
            console.log('❌ FALSE POSITIVE: IndependentServiceA should NOT depend on IndependentServiceB');
            console.log(`   Reason: Comments and string literals should be ignored`);
            testsPassed = false;
        } else if (serviceA) {
            console.log('✅ CORRECT: IndependentServiceA does not depend on IndependentServiceB');
        }
        
        if (serviceB && serviceB.dependencies.includes('TestScenarios.FalsePositiveTest.IndependentServiceA')) {
            console.log('❌ FALSE POSITIVE: IndependentServiceB should NOT depend on IndependentServiceA');
            console.log(`   Reason: Comments and string literals should be ignored`);
            testsPassed = false;
        } else if (serviceB) {
            console.log('✅ CORRECT: IndependentServiceB does not depend on IndependentServiceA');
        }
        
        // Test 2: Linear chain should NOT have circular dependencies
        const chainA = falsePositiveClasses.get('TestScenarios.FalsePositiveTest.LinearChainA');
        const chainB = falsePositiveClasses.get('TestScenarios.FalsePositiveTest.LinearChainB');
        const chainC = falsePositiveClasses.get('TestScenarios.FalsePositiveTest.LinearChainC');
        
        // Verify linear dependencies: A → B → C (no cycles)
        if (chainA && chainA.dependencies.includes('TestScenarios.FalsePositiveTest.LinearChainB')) {
            console.log('✅ CORRECT: LinearChainA depends on LinearChainB');
        } else if (chainA) {
            console.log('❌ MISSING DEPENDENCY: LinearChainA should depend on LinearChainB');
            testsPassed = false;
        }
        
        if (chainB && chainB.dependencies.includes('TestScenarios.FalsePositiveTest.LinearChainC')) {
            console.log('✅ CORRECT: LinearChainB depends on LinearChainC');
        } else if (chainB) {
            console.log('❌ MISSING DEPENDENCY: LinearChainB should depend on LinearChainC');
            testsPassed = false;
        }
        
        if (chainC && (chainC.dependencies.includes('TestScenarios.FalsePositiveTest.LinearChainA') || 
                      chainC.dependencies.includes('TestScenarios.FalsePositiveTest.LinearChainB'))) {
            console.log('❌ FALSE POSITIVE: LinearChainC should NOT depend on LinearChainA or LinearChainB');
            testsPassed = false;
        } else if (chainC) {
            console.log('✅ CORRECT: LinearChainC has no backward dependencies');
        }
        
        // Test 3: No circular dependencies should be detected in false positive scenarios
        if (circularDeps.length > 0) {
            console.log('❌ FALSE POSITIVE CIRCULAR DEPENDENCIES DETECTED:');
            for (const circular of circularDeps) {
                console.log(`   - ${circular.description}`);
            }
            testsPassed = false;
        } else {
            console.log('✅ CORRECT: No circular dependencies in false positive test scenarios');
        }
        
        console.log('\n📊 FINAL RESULT');
        console.log('===============');
        
        if (testsPassed) {
            console.log('🎉 ALL FALSE POSITIVE TESTS PASSED!');
            console.log('   ✅ No false positives detected');
            console.log('   ✅ Comments and string literals properly ignored'); 
            console.log('   ✅ Linear dependencies correctly detected');
            console.log('   ✅ No spurious circular dependencies');
            return true;
        } else {
            console.log('🚨 FALSE POSITIVE DETECTION FAILED!');
            console.log('   The analyzer is detecting dependencies where none should exist.');
            return false;
        }
        
    } catch (error) {
        console.error('💥 ERROR during false positive test:', error);
        return false;
    }
}

// Run the false positive test
runFalsePositiveTest().then(success => {
    process.exit(success ? 0 : 1);
}).catch(error => {
    console.error('💥 FATAL ERROR:', error);
    process.exit(1);
});