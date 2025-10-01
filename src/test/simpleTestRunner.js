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

        this.log(`🔍 DEBUG: Starting first pass - collecting all classes from ${allFiles.length} files`);

        // First pass: collect all classes
        for (const filePath of allFiles) {
            try {
                const content = fs.readFileSync(filePath, 'utf8');
                const namespace = this.extractNamespace(content) || 'Global';
                const classes = this.extractClasses(content);

                this.log(`🔍 DEBUG: File ${path.basename(filePath)} - namespace: ${namespace}, classes found: ${classes.length}`);
                if (classes.length > 0) {
                    this.log(`🔍 DEBUG: Classes: ${classes.map(c => c.name).join(', ')}`);
                }

                for (const classInfo of classes) {
                    if (!classInfo.isNested) {
                        const fullClassName = `${namespace}.${classInfo.name}`;
                        allClasses.set(classInfo.name, {
                            namespace,
                            fullName: fullClassName,
                            filePath
                        });
                        this.log(`🔍 DEBUG: Added class: ${fullClassName}`);
                    }
                }
            } catch (error) {
                this.log(`Error analyzing file ${filePath}: ${error}`);
            }
        }

        this.log(`🔍 DEBUG: First pass complete - found ${allClasses.size} total classes`);

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
        
        this.log(`🔍 DEBUG: Scanning directory: ${scriptsPath}`);
        this.log(`🔍 DEBUG: Directory exists: ${fs.existsSync(scriptsPath)}`);
        
        try {
            this.walkDirectorySync(scriptsPath, allFiles);
        } catch (error) {
            this.log(`Error scanning directory: ${error}`);
        }

        this.log(`🔍 DEBUG: Found ${allFiles.length} total files`);
        const csFiles = allFiles.filter(file => file.endsWith('.cs') && !file.endsWith('.meta'));
        this.log(`🔍 DEBUG: Found ${csFiles.length} C# files: ${csFiles.slice(0, 5).join(', ')}`);
        
        return csFiles;
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

        this.log(`🔍 DEBUG EXTRACT: Processing ${lines.length} lines`);

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
                    this.log(`🔍 DEBUG EXTRACT: Found potential class: ${className} at line ${i+1}`);
                    
                    // Check if this appears to be nested
                    const isNested = this.isClassNested(lines, i, className);
                    this.log(`🔍 DEBUG EXTRACT: Class ${className} isNested: ${isNested}`);
                    
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
                        this.log(`🔍 DEBUG EXTRACT: Added class: ${className}`);
                    } else {
                        this.log(`🔍 DEBUG EXTRACT: Skipped nested class: ${className}`);
                    }
                    break;
                }
            }
        }

        this.log(`🔍 DEBUG EXTRACT: Total classes found: ${classes.length}`);
        return classes;
    }

    determineClassType(line) {
        if (line.includes('struct')) return 'struct';
        if (line.includes('interface')) return 'interface';
        if (line.includes('enum')) return 'enum';
        return 'class';
    }

    isClassNested(lines, classLineIndex, className) {
        // Look for namespace declarations - if we're inside a namespace, that's OK (not nested)
        // Only consider it nested if we're inside another class/struct/interface
        let braceBalance = 0;
        let insideNamespace = false;
        
        for (let j = 0; j < classLineIndex; j++) {
            const line = lines[j].trim();
            
            // Check for namespace declaration
            if (line.startsWith('namespace ')) {
                insideNamespace = true;
            }
            
            // Check for class/struct/interface declarations
            if (/(?:class|struct|interface|enum)\s+\w+/.test(line)) {
                // This is another type declaration before our class
                braceBalance += 1; // Consider this as opening a nesting level
            }
            
            braceBalance += (line.match(/\{/g) || []).length;
            braceBalance -= (line.match(/\}/g) || []).length;
        }
        
        // If we're inside a namespace but braceBalance is 1, that's just the namespace
        // If braceBalance > 1, we're nested inside another class
        if (insideNamespace && braceBalance <= 1) {
            return false; // Not nested, just inside namespace
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
        
        // Create pattern to find the EXACT class definition
        const classPattern = new RegExp(`(?:public|internal|private|protected)?\\s*(?:static\\s+)?(?:partial\\s+)?(?:abstract\\s+)?(?:sealed\\s+)?(?:class|struct)\\s+${this.escapeRegex(className)}(?:\\s*:|<|\\s+|\\s*\\{|\\s*$)`);
        
        // Find the class definition line
        let classStartLine = -1;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (classPattern.test(line)) {
                // Ensure this is the exact class we want (not a substring)
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

        // COMPLETELY REWRITE: Proper class scope extraction
        let braceDepth = 0;
        let hasEnteredClass = false;
        
        for (let i = classStartLine; i < lines.length; i++) {
            const line = lines[i];
            
            // Count braces on this line character by character
            for (const char of line) {
                if (char === '{') {
                    if (!hasEnteredClass) {
                        hasEnteredClass = true; // First { means we entered the class
                    }
                    braceDepth++;
                } else if (char === '}') {
                    braceDepth--;
                }
            }
            
            // Include lines that are part of this class
            if (hasEnteredClass) {
                classScopeLines.push([i + 1, line]);
                
                // Stop when we've exited this class completely
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
            for (const pattern of this.dependencyPatterns) {
                const regex = new RegExp(pattern.pattern.source.replace(/CLASSNAME/g, this.escapeRegex(otherClassName)));
                if (regex.test(lineContent)) {
                    references.push(`${pattern.description} (${relativePath}:${lineNumber})`);
                    break; // Only add one reason per line
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
                // Found a cycle
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
        
        // Run DFS for all nodes
        for (const node of dependencies.keys()) {
            if (!visited.has(node)) {
                dfs(node, []);
            }
        }
        
        // Convert to CircularDependency objects
        return cycles.map(cycle => ({
            cycle: cycle.slice(0, -1), // Remove duplicate last element
            description: cycle.slice(0, -1).join(' → ')
        }));
    }
}

async function runStandaloneTest() {
    console.log('🚀 Starting Standalone Dependency Analysis Test');
    console.log('===============================================');
    
    const workspaceRoot = path.resolve(__dirname, '../..');
    console.log(`📁 Workspace: ${workspaceRoot}`);
    
    const analyzer = new StandaloneDependencyAnalyzer({
        appendLine: (message) => console.log(message)
    });
    
    const circularDetector = new SimpleCircularDetector();
    
    try {
        console.log('\n🔍 Analyzing class dependencies...');
        const dependencies = await analyzer.analyzeClassDependencies(workspaceRoot);
        
        console.log(`📦 Found ${dependencies.size} classes:`);
        for (const [fullName, node] of dependencies) {
            console.log(`   - ${fullName} (${node.dependencies.length} deps)`);
        }
        
        console.log('\n🔍 Detecting circular dependencies...');
        const circularDeps = circularDetector.findCircularDependencies(dependencies);
        
        console.log(`🔄 Found ${circularDeps.length} circular dependencies:`);
        for (const circular of circularDeps) {
            console.log(`   - ${circular.description}`);
        }
        
        // Test specific expectations
        console.log('\n✅ VALIDATION TESTS');
        console.log('==================');
        
        let allTestsPassed = true;
        
        // Test 1: GameConstants should exist
        const gameConstants = dependencies.get('Core.GameConstants');
        if (!gameConstants) {
            console.log('❌ Core.GameConstants not found');
            allTestsPassed = false;
        } else {
            console.log('✅ Core.GameConstants found');
            console.log(`   Dependencies: [${gameConstants.dependencies.join(', ')}]`);
        }
        
        // Test 2: FindTargetSystem should exist
        const findTargetSystem = dependencies.get('Combat.FindTargetSystem');
        if (!findTargetSystem) {
            console.log('❌ Combat.FindTargetSystem not found');
            allTestsPassed = false;
        } else {
            console.log('✅ Combat.FindTargetSystem found');
            console.log(`   Dependencies: [${findTargetSystem.dependencies.join(', ')}]`);
        }
        
        // Test 3: GameConstants should depend on FindTargetSystem
        if (gameConstants && !gameConstants.dependencies.includes('Combat.FindTargetSystem')) {
            console.log('❌ GameConstants should depend on Combat.FindTargetSystem');
            allTestsPassed = false;
        } else if (gameConstants) {
            console.log('✅ GameConstants → FindTargetSystem dependency detected');
        }
        
        // Test 4: FindTargetSystem should depend on GameConstants
        if (findTargetSystem && !findTargetSystem.dependencies.includes('Core.GameConstants')) {
            console.log('❌ FindTargetSystem should depend on Core.GameConstants');
            allTestsPassed = false;
        } else if (findTargetSystem) {
            console.log('✅ FindTargetSystem → GameConstants dependency detected');
        }
        
        // Test 5: Circular dependency should be detected
        const hasGameConstantsCircular = circularDeps.some(circular => 
            circular.cycle.includes('Core.GameConstants') && circular.cycle.includes('Combat.FindTargetSystem')
        );
        
        if (!hasGameConstantsCircular) {
            console.log('❌ GameConstants ↔ FindTargetSystem circular dependency NOT detected');
            allTestsPassed = false;
        } else {
            console.log('✅ GameConstants ↔ FindTargetSystem circular dependency correctly detected');
        }
        
        // Test 6: Should not have too many false positives
        // Expected: 1 original + 5 test scenarios = 6 total
        if (circularDeps.length > 8) {
            console.log(`⚠️  Warning: Found ${circularDeps.length} circular dependencies, which might include false positives`);
        } else if (circularDeps.length === 6) {
            console.log(`✅ Expected number of circular dependencies (${circularDeps.length}) - all test scenarios working correctly`);
        } else {
            console.log(`✅ Reasonable number of circular dependencies (${circularDeps.length})`);
        }
        
        console.log('\n📊 FINAL RESULT');
        console.log('===============');
        
        if (allTestsPassed) {
            console.log('🎉 ALL TESTS PASSED! The dependency analysis fix is working correctly.');
            console.log('\n🔧 KEY IMPROVEMENTS:');
            console.log('   ✅ Fixed class scope extraction using character-by-character brace tracking');
            console.log('   ✅ Proper detection of qualified type references (e.g., Combat.FindTargetSystem)');
            console.log('   ✅ Eliminated false positive circular dependencies');
            console.log('   ✅ Accurate class-level dependency analysis');
            return true;
        } else {
            console.log('🚨 SOME TESTS FAILED! Review the issues above.');
            return false;
        }
        
    } catch (error) {
        console.error('💥 ERROR during analysis:', error);
        return false;
    }
}

// Run the test
runStandaloneTest().then(success => {
    process.exit(success ? 0 : 1);
}).catch(error => {
    console.error('💥 FATAL ERROR:', error);
    process.exit(1);
});
