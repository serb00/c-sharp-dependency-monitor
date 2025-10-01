import * as path from 'path';
import * as fs from 'fs';
export class StandaloneDependencyAnalyzer {
    constructor(outputChannel) {
        this.dependencyPatterns = this.initializeDependencyPatterns();
        this.outputChannel = outputChannel || {
            appendLine: (message) => console.log(message)
        };
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
                const content = await this.readFileContent(filePath);
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
            }
            catch (error) {
                this.log(`Error analyzing file ${filePath}: ${error}`);
            }
        }
        // Second pass: find dependencies with detailed reasons
        for (const filePath of allFiles) {
            try {
                const content = await this.readFileContent(filePath);
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
                    // CRITICAL FIX: Also process qualified type references in class scope (e.g., Combat.FindTarget)
                    const classScopeContent = classScopeLines.map(([_, line]) => line).join('\n');
                    const qualifiedTypeRefs = this.extractQualifiedTypeReferences(classScopeContent);
                    for (const typeRef of qualifiedTypeRefs) {
                        const targetNamespace = typeRef.namespace;
                        const typeName = typeRef.context.replace('qualified type reference to ', '');
                        const fullTargetClass = `${targetNamespace}.${typeName}`;
                        // Check if this qualified reference points to a known class by full name
                        let found = false;
                        for (const [className, classInfo] of allClasses) {
                            if (classInfo.fullName === fullTargetClass && classInfo.fullName !== fullClassName) {
                                classDeps.push(classInfo.fullName);
                                const relativePath = this.getRelativePath(filePath, workspaceRoot);
                                if (!classDepDetails.has(classInfo.fullName)) {
                                    classDepDetails.set(classInfo.fullName, []);
                                }
                                classDepDetails.get(classInfo.fullName).push(`qualified type reference to ${typeName} (${relativePath}:${typeRef.lineNumber})`);
                                found = true;
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
                        const foundReferences = this.findClassReferences(classScopeLines, otherClassName, filePath, workspaceRoot);
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
            }
            catch (error) {
                this.log(`Error analyzing file ${filePath}: ${error}`);
            }
        }
        return dependencies;
    }
    // Helper methods
    async getAllCSharpFiles(workspaceRoot) {
        const allFiles = [];
        const scriptsPath = path.join(workspaceRoot, 'src/test/Scripts');
        try {
            await this.walkDirectory(scriptsPath, allFiles);
        }
        catch (error) {
            this.log(`Error scanning directory: ${error}`);
        }
        return allFiles.filter(file => file.endsWith('.cs') && !file.endsWith('.meta'));
    }
    async walkDirectory(dir, files) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await this.walkDirectory(fullPath, files);
            }
            else if (entry.isFile() && entry.name.endsWith('.cs')) {
                files.push(fullPath);
            }
        }
    }
    async readFileContent(filePath) {
        return fs.readFileSync(filePath, 'utf8');
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
        if (line.includes('struct'))
            return 'struct';
        if (line.includes('interface'))
            return 'interface';
        if (line.includes('enum'))
            return 'enum';
        return 'class';
    }
    isClassNested(lines, classLineIndex, className) {
        // Simple nested check - look for unclosed braces before this line
        let braceBalance = 0;
        for (let j = 0; j < classLineIndex; j++) {
            const line = lines[j];
            braceBalance += (line.match(/\{/g) || []).length;
            braceBalance -= (line.match(/\}/g) || []).length;
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
                const hasExactClassName = words.some(word => word === className ||
                    word.startsWith(className + ':') ||
                    word.startsWith(className + '<') ||
                    word.startsWith(className + '{'));
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
                }
                else if (char === '}') {
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
        const relativePath = this.getRelativePath(filePath, workspaceRoot);
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
    initializeDependencyPatterns() {
        return [
            { pattern: /:\s*CLASSNAME/, description: 'inheritance', weight: 10 },
            { pattern: /:\s*.*,\s*CLASSNAME/, description: 'interface implementation', weight: 9 },
            { pattern: /(?:public|private|protected|internal)\s+CLASSNAME\s+\w+/, description: 'field declaration', weight: 8 },
            { pattern: /<CLASSNAME>/, description: 'generic type parameter', weight: 7 },
            { pattern: /new\s+CLASSNAME\s*[\(\{]/, description: 'object instantiation', weight: 6 },
            { pattern: /CLASSNAME\.\w+/, description: 'static member access', weight: 5 },
            { pattern: /\bCLASSNAME\b/, description: 'general reference', weight: 3 }
        ];
    }
    escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    getRelativePath(filePath, workspaceRoot) {
        return path.relative(workspaceRoot, filePath);
    }
}
