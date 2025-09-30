import * as path from 'path';
import { Utils } from './utils';
import { ConfigManager } from './configManager';
import { 
    DependencyNode, 
    DependencyDetail, 
    FileAnalysisResult, 
    ClassInfo, 
    UsingStatement, 
    SystemInfo, 
    AnalysisResult, 
    AnalysisLevel,
    DependencyPattern
} from './types';

export class DependencyAnalyzer {
    private configManager: ConfigManager;
    private dependencyPatterns: DependencyPattern[];

    constructor() {
        this.configManager = ConfigManager.getInstance();
        this.dependencyPatterns = this.initializeDependencyPatterns();
    }

    /**
     * Main analysis entry point - analyzes dependencies at the specified or configured level
     * LEGITIMATE USE: Called by cascading analysis system for initial full analysis when no cache exists
     * DEPRECATED USE: Direct calls from outside cascading system should use performIncrementalCascadingAnalysis()
     */
    public async analyzeProject(workspaceRoot: string, level?: AnalysisLevel): Promise<AnalysisResult> {
        const startTime = Date.now();
        const config = this.configManager.getConfig();
        const analysisLevel = level || config.level;
        
        // Check if this is being called from the legitimate cascading analysis system
        const stackTrace = new Error().stack || '';
        const isCalledFromCascadingSystem = stackTrace.includes('analyzeNamespaceLevel') ||
                                          stackTrace.includes('analyzeClassLevel') ||
                                          stackTrace.includes('analyzeSystemLevel');
        
        if (!isCalledFromCascadingSystem) {
            console.warn('⚠️  DEPRECATION WARNING: analyzeProject() called from outside the optimized cascading analysis system. For new code, please use performIncrementalCascadingAnalysis() instead.');
        }
        
        let dependencies: Map<string, DependencyNode>;
        let affectedFiles: string[] = [];

        switch (analysisLevel) {
            case 'namespace':
                dependencies = await this.analyzeNamespaceDependencies(workspaceRoot);
                break;
            case 'class':
                dependencies = await this.analyzeClassDependencies(workspaceRoot);
                break;
            case 'system':
                dependencies = await this.analyzeSystemDependencies(workspaceRoot);
                break;
            default:
                throw new Error(`Unsupported analysis level: ${analysisLevel}`);
        }

        // Get all analyzed files
        affectedFiles = Array.from(dependencies.values()).map(dep => dep.filePath);
        const uniqueFiles = [...new Set(affectedFiles)];

        return {
            dependencies,
            circularDependencies: [], // Will be populated by CircularDependencyDetector
            analysisLevel,
            timestamp: new Date(),
            affectedFiles: uniqueFiles,
            totalFiles: uniqueFiles.length
        };
    }

    /**
     * Analyze namespace-level dependencies (ported from Python)
     */
    public async analyzeNamespaceDependencies(workspaceRoot: string): Promise<Map<string, DependencyNode>> {
        const dependencies = new Map<string, DependencyNode>();
        const config = this.configManager.getConfig();
        const allFiles = await this.getAllCSharpFiles(workspaceRoot);

        // First pass: collect all using statements with file locations
        const namespaceUsings = new Map<string, Map<string, string[]>>();

        for (const filePath of allFiles) {
            try {
                const content = await Utils.readFileContent(filePath);
                const namespace = Utils.extractNamespace(content);
                
                if (!namespace) {
                    continue;
                }

                const usingStatements = Utils.extractUsingStatements(content);
                
                for (const usingStmt of usingStatements) {
                    const targetNamespace = usingStmt.namespace;
                    
                    // Skip ignored namespaces and self-references
                    if (Utils.shouldIgnoreNamespace(targetNamespace, config.ignoredNamespaces) || 
                        targetNamespace === namespace) {
                        continue;
                    }

                    if (!namespaceUsings.has(namespace)) {
                        namespaceUsings.set(namespace, new Map());
                    }

                    const nsMap = namespaceUsings.get(namespace)!;
                    if (!nsMap.has(targetNamespace)) {
                        nsMap.set(targetNamespace, []);
                    }

                    const relativePath = Utils.getRelativePath(filePath, workspaceRoot);
                    nsMap.get(targetNamespace)!.push(`${relativePath}:${usingStmt.lineNumber}`);
                }
            } catch (error) {
                console.warn(`Error analyzing file ${filePath}:`, error);
            }
        }

        // Build dependencies and details
        for (const [namespace, targets] of namespaceUsings) {
            if (targets.size > 0) {
                const dependencyDetails: DependencyDetail[] = [];
                const deps: string[] = [];

                for (const [target, files] of targets) {
                    deps.push(target);
                    dependencyDetails.push({
                        target,
                        reasons: files,
                        lineNumbers: files.map(f => parseInt(f.split(':')[1]) || 0)
                    });
                }

                dependencies.set(namespace, {
                    name: namespace.split('.').pop() || namespace,
                    namespace: namespace,
                    fullName: namespace,
                    filePath: '', // Namespace doesn't have a single file
                    dependencies: deps,
                    dependencyDetails,
                    classType: undefined // Namespaces don't have a specific type
                });
            }
        }

        return dependencies;
    }

    /**
     * Analyze class-level dependencies (ported from Python)
     */
    public async analyzeClassDependencies(workspaceRoot: string): Promise<Map<string, DependencyNode>> {
        const dependencies = new Map<string, DependencyNode>();
        const config = this.configManager.getConfig();
        const allFiles = await this.getAllCSharpFiles(workspaceRoot);
        const allClasses = new Map<string, { namespace: string; fullName: string; filePath: string }>();

        

        // First pass: collect all classes
        for (const filePath of allFiles) {
            try {
                const content = await Utils.readFileContent(filePath);
                const namespace = Utils.extractNamespace(content) || 'Global';
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
                console.warn(`Error analyzing file ${filePath}:`, error);
            }
        }

        

        // Second pass: find dependencies with detailed reasons
        for (const filePath of allFiles) {
            try {
                const content = await Utils.readFileContent(filePath);
                const namespace = Utils.extractNamespace(content) || 'Global';
                const usingStatements = Utils.extractUsingStatements(content);
                const customUsings = usingStatements
                    .filter(u => !Utils.shouldIgnoreNamespace(u.namespace, config.ignoredNamespaces))
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
                    const classDeps: string[] = [];
                    const classDepDetails = new Map<string, string[]>();

                    // Extract the specific scope of this class
                    const lines = content.split('\n');
                    const classScopeLines = this.extractClassScope(lines, className);

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

                    // CRITICAL FIX: Add ALL classes to dependencies map, not just those with outgoing dependencies
                    // This ensures "leaf" classes (structs, components, enums) appear in visualization as targets
                    if (true) { // Always add classes to dependencies map
                        const dependencyDetails: DependencyDetail[] = [];
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
            } catch (error) {
                console.warn(`Error analyzing file ${filePath}:`, error);
            }
        }

        

        return dependencies;
    }

    /**
     * Analyze system-level dependencies (Unity ECS focused, ported from Python)
     */
    public async analyzeSystemDependencies(workspaceRoot: string): Promise<Map<string, DependencyNode>> {
        const dependencies = new Map<string, DependencyNode>();
        const config = this.configManager.getConfig();
        const allFiles = await this.getAllCSharpFiles(workspaceRoot);
        const allSystems = new Set<string>();
        const systemClasses = new Map<string, { namespace: string; fullName: string; filePath: string }>();

        // Find all System classes
        for (const filePath of allFiles) {
            try {
                const content = await Utils.readFileContent(filePath);
                const namespace = Utils.extractNamespace(content) || 'Global';
                const systems = this.extractSystemClasses(content);

                for (const systemInfo of systems) {
                    if (!systemInfo.name.endsWith('Authoring') && 
                        !systemInfo.name.endsWith('Baker') && 
                        !systemInfo.name.endsWith('Data')) {
                        const fullName = `${namespace}.${systemInfo.name}`;
                        systemClasses.set(systemInfo.name, {
                            namespace,
                            fullName,
                            filePath
                        });
                        allSystems.add(fullName);
                    }
                }
            } catch (error) {
                console.warn(`Error analyzing file ${filePath}:`, error);
            }
        }

        // Find dependencies between systems
        for (const filePath of allFiles) {
            try {
                const content = await Utils.readFileContent(filePath);
                const namespace = Utils.extractNamespace(content) || 'Global';
                const usingStatements = Utils.extractUsingStatements(content);
                const customUsings = usingStatements
                    .filter(u => !Utils.shouldIgnoreNamespace(u.namespace, config.ignoredNamespaces))
                    .map(u => u.namespace);

                const currentSystems = this.extractSystemClasses(content)
                    .filter(s => systemClasses.has(s.name))
                    .map(s => ({
                        name: s.name,
                        fullName: `${namespace}.${s.name}`
                    }));

                // For each system in this file, find dependencies on other systems
                for (const { name: systemName, fullName: fullSystemName } of currentSystems) {
                    const systemDeps: string[] = [];
                    const systemDepDetails = new Map<string, string[]>();
                    const lines = content.split('\n');

                    for (const [otherSystemName, otherSystemInfo] of systemClasses) {
                        if (otherSystemInfo.fullName === fullSystemName) {
                            continue;
                        }

                        // Check namespace availability
                        if (!(otherSystemInfo.namespace === namespace ||
                              customUsings.includes(otherSystemInfo.namespace) ||
                              otherSystemInfo.namespace === 'Global')) {
                            continue;
                        }

                        // Find system-specific usage patterns
                        const foundReferences = this.findSystemReferences(
                            lines,
                            otherSystemName,
                            filePath,
                            workspaceRoot
                        );

                        if (foundReferences.length > 0) {
                            systemDeps.push(otherSystemInfo.fullName);
                            systemDepDetails.set(otherSystemInfo.fullName, foundReferences);
                        }
                    }

                    // Always add the system to dependencies, even if it has no deps
                    const dependencyDetails: DependencyDetail[] = [];
                    for (const [target, reasons] of systemDepDetails) {
                        dependencyDetails.push({
                            target,
                            reasons,
                            lineNumbers: reasons.map(r => {
                                const match = r.match(/:(\d+)\)/);
                                return match ? parseInt(match[1]) : 0;
                            })
                        });
                    }

                    // Get the actual system info to determine if it's a class or struct
                    const currentSystems = this.extractSystemClasses(content);
                    const systemInfo = currentSystems.find(s => s.name === systemName);
                    const actualClassType = systemInfo?.classType || 'class';
                    
                    dependencies.set(fullSystemName, {
                        name: systemName,
                        namespace,
                        fullName: fullSystemName,
                        filePath,
                        dependencies: [...new Set(systemDeps)],
                        dependencyDetails,
                        classType: actualClassType
                    });
                }
            } catch (error) {
                console.warn(`Error analyzing file ${filePath}:`, error);
            }
        }

        // Add any remaining systems that weren't processed (standalone systems)
        for (const systemFullName of allSystems) {
            if (!dependencies.has(systemFullName)) {
                const parts = systemFullName.split('.');
                const name = parts[parts.length - 1];
                const namespace = parts.slice(0, -1).join('.');
                
                dependencies.set(systemFullName, {
                    name,
                    namespace,
                    fullName: systemFullName,
                    filePath: '', // Will be filled by systemClasses lookup
                    dependencies: [],
                    dependencyDetails: [],
                    classType: 'class' // Default for systems
                });
            }
        }

        return dependencies;
    }

    private async getAllCSharpFiles(workspaceRoot: string): Promise<string[]> {
        const config = this.configManager.getConfig();
        const allFiles: string[] = [];

        for (const projectPath of config.projectPaths) {
            const fullPath = path.join(workspaceRoot, projectPath);
            try {
                const files = await Utils.getCSharpFiles(fullPath);
                allFiles.push(...files);
            } catch (error) {
                // Path might not exist, which is fine
            }
        }

        return allFiles;
    }

    private extractClasses(content: string): ClassInfo[] {
        const classes: ClassInfo[] = [];
        const lines = content.split('\n');
        const nestedClasses = new Set<string>();

        const classPatterns = [
            // Comprehensive class patterns (all access modifiers and keywords)
            /(?:public|internal|private|protected)?\s*(?:static\s+)?(?:partial\s+)?(?:abstract\s+)?(?:sealed\s+)?class\s+(\w+)/,
            
            // Comprehensive struct patterns (all access modifiers and keywords)
            /(?:public|internal|private|protected)?\s*(?:static\s+)?(?:partial\s+)?(?:readonly\s+)?struct\s+(\w+)/,
            
            // Interface patterns
            /(?:public|internal|private|protected)?\s*(?:partial\s+)?interface\s+(\w+)/,
            
            // Enum patterns
            /(?:public|internal|private|protected)?\s*enum\s+(\w+)/,
            
            // Record patterns (C# 9+)
            /(?:public|internal|private|protected)?\s*(?:sealed\s+)?record\s+(\w+)/,
            /(?:public|internal|private|protected)?\s*(?:sealed\s+)?record\s+class\s+(\w+)/,
            /(?:public|internal|private|protected)?\s*(?:sealed\s+)?record\s+struct\s+(\w+)/,
            
            // Delegate patterns
            /(?:public|internal|private|protected)?\s*delegate\s+\w+\s+(\w+)/
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
                            fullName: className, // Will be prefixed with namespace later
                            namespace: '', // Will be filled later
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

    private extractSystemClasses(content: string): SystemInfo[] {
        const systems: SystemInfo[] = [];
        const systemPatterns = [
            /(?:public|internal|private)?\s*(?:partial\s+)?(?:struct|class)\s+(\w*System\w*)(?:\s*:|<|\s+|\s*\{)/,
            /(?:public|internal|private)?\s*(?:partial\s+)?(?:struct|class)\s+(\w+)\s*:\s*.*ISystem/,
            /(?:public|internal|private)?\s*(?:partial\s+)?struct\s+(\w+)\s*:\s*.*ISystem/
        ];

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            for (const pattern of systemPatterns) {
                const match = pattern.exec(line);
                if (match) {
                    const className = match[1];
                    if (className && !className.endsWith('Authoring') && 
                        !className.endsWith('Baker') && !className.endsWith('Data')) {
                        
                        const systemType = this.determineSystemType(lines, i);
                        systems.push({
                            name: className,
                            fullName: className,
                            namespace: '',
                            isNested: false,
                            startLine: i + 1,
                            endLine: this.findClassEndLine(lines, i),
                            classType: line.includes('struct') ? 'struct' : 'class',
                            isSystem: true,
                            systemType
                        });
                    }
                    break;
                }
            }
        }

        return systems;
    }

    private determineSystemType(lines: string[], classLineIndex: number): 'ISystem' | 'SystemBase' | 'ComponentSystem' | 'JobComponentSystem' | 'NamedSystem' {
        const classLine = lines[classLineIndex];
        
        if (classLine.includes('ISystem')) return 'ISystem';
        if (classLine.includes('SystemBase')) return 'SystemBase';
        if (classLine.includes('ComponentSystem')) return 'ComponentSystem';
        if (classLine.includes('JobComponentSystem')) return 'JobComponentSystem';
        
        return 'NamedSystem';
    }

    private determineClassType(line: string): 'class' | 'struct' | 'interface' | 'enum' | 'record' | 'record struct' | 'delegate' {
        // Order matters - check more specific patterns first
        if (line.includes('record struct')) return 'record struct';
        if (line.includes('record class') || (line.includes('record ') && !line.includes('record struct'))) return 'record';
        if (line.includes('struct')) return 'struct';
        if (line.includes('interface')) return 'interface';
        if (line.includes('enum')) return 'enum';
        if (line.includes('delegate')) return 'delegate';
        return 'class';
    }

    private isClassNested(lines: string[], classLineIndex: number, className: string): boolean {
        // Look backwards for an enclosing class/struct
        for (let j = classLineIndex - 1; j >= Math.max(0, classLineIndex - 50); j--) {
            const prevLine = lines[j].trim();
            if (!prevLine || prevLine.startsWith('//')) {
                continue;
            }

            // If we find another class/struct declaration
            if (/\b(?:class|struct)\s+\w+/.test(prevLine)) {
                // Count braces between the previous class and current line
                let braceBalance = 0;
                for (let k = j; k < classLineIndex; k++) {
                    const lineToCheck = lines[k];
                    braceBalance += (lineToCheck.match(/\{/g) || []).length;
                    braceBalance -= (lineToCheck.match(/\}/g) || []).length;
                }

                // If brace_balance > 0, we're still inside the previous class/struct
                if (braceBalance > 0) {
                    return true;
                } else {
                    break; // We found a closed class, so we're not nested
                }
            }
        }

        return false;
    }

    private findClassEndLine(lines: string[], startLine: number): number {
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

    private extractClassScope(lines: string[], className: string): Array<[number, string]> {
        const classScopeLines: Array<[number, string]> = [];
        const classPattern = new RegExp(`(?:class|struct)\\s+${Utils.escapeRegex(className)}(?:\\s*:|<|\\s+|\\s*\\{)`);

        // Find the class definition line
        let classStartLine = -1;
        for (let i = 0; i < lines.length; i++) {
            if (classPattern.test(lines[i])) {
                classStartLine = i;
                break;
            }
        }

        if (classStartLine === -1) {
            return classScopeLines;
        }

        // Find the matching closing brace for this class
        let braceCount = 0;
        let inClass = false;

        for (let i = classStartLine; i < lines.length; i++) {
            const line = lines[i];

            if (line.includes('{')) {
                braceCount += (line.match(/\{/g) || []).length;
                inClass = true;
            }

            if (inClass) {
                classScopeLines.push([i + 1, line]);
            }

            if (line.includes('}')) {
                braceCount -= (line.match(/\}/g) || []).length;
            }

            if (inClass && braceCount <= 0) {
                break;
            }
        }

        return classScopeLines;
    }

    private findClassReferences(
        classScopeLines: Array<[number, string]>,
        otherClassName: string,
        filePath: string,
        workspaceRoot: string
    ): string[] {
        const references: string[] = [];
        const relativePath = Utils.getRelativePath(filePath, workspaceRoot);

        for (const [lineNumber, lineContent] of classScopeLines) {
            for (const pattern of this.dependencyPatterns) {
                const regex = new RegExp(pattern.pattern.source.replace(/CLASSNAME/g, Utils.escapeRegex(otherClassName)));
                if (regex.test(lineContent)) {
                    references.push(`${pattern.description} (${relativePath}:${lineNumber})`);
                    break; // Only add one reason per line
                }
            }
        }

        

        return references;
    }

    private findSystemReferences(
        lines: string[], 
        otherSystemName: string, 
        filePath: string,
        workspaceRoot: string
    ): string[] {
        const references: string[] = [];
        const relativePath = Utils.getRelativePath(filePath, workspaceRoot);

        const systemPatterns = [
            { pattern: new RegExp(`\\[UpdateBefore\\(typeof\\(${Utils.escapeRegex(otherSystemName)}\\)\\)\\]`), description: 'UpdateBefore dependency' },
            { pattern: new RegExp(`\\[UpdateAfter\\(typeof\\(${Utils.escapeRegex(otherSystemName)}\\)\\)\\]`), description: 'UpdateAfter dependency' },
            { pattern: new RegExp(`UpdateBefore.*${Utils.escapeRegex(otherSystemName)}`), description: 'UpdateBefore dependency' },
            { pattern: new RegExp(`UpdateAfter.*${Utils.escapeRegex(otherSystemName)}`), description: 'UpdateAfter dependency' },
            { pattern: new RegExp(`SystemAPI\\.GetSingleton<${Utils.escapeRegex(otherSystemName)}>`), description: 'SystemAPI singleton access' },
            { pattern: new RegExp(`World\\.GetOrCreateSystem<${Utils.escapeRegex(otherSystemName)}>`), description: 'system reference' },
            { pattern: new RegExp(`typeof\\(${Utils.escapeRegex(otherSystemName)}\\)`), description: 'typeof reference' },
            { pattern: new RegExp(`\\b${Utils.escapeRegex(otherSystemName)}\\b.*\\s+\\w+\\s*[;=]`), description: 'variable/field reference' },
            { pattern: new RegExp(`\\b${Utils.escapeRegex(otherSystemName)}\\b`), description: 'general reference' }
        ];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            for (const { pattern, description } of systemPatterns) {
                if (pattern.test(line)) {
                    references.push(`${description} (${relativePath}:${i + 1})`);
                    break;
                }
            }
        }

        return references;
    }

    private initializeDependencyPatterns(): DependencyPattern[] {
        return [
            { pattern: /:\s*CLASSNAME/, description: 'inheritance', weight: 10 },
            { pattern: /:\s*.*,\s*CLASSNAME/, description: 'interface implementation', weight: 9 },
            { pattern: /(?:public|private|protected|internal)\s+CLASSNAME\s+\w+/, description: 'field declaration', weight: 8 },
            { pattern: /<CLASSNAME>/, description: 'generic type parameter', weight: 7 },
            { pattern: /RefRW<CLASSNAME>/, description: 'ECS component reference (RefRW)', weight: 8 },
            { pattern: /RefRO<CLASSNAME>/, description: 'ECS component reference (RefRO)', weight: 8 },
            { pattern: /SystemAPI\..*<.*CLASSNAME.*>/, description: 'SystemAPI call', weight: 7 },
            { pattern: /new\s+CLASSNAME\s*[\(\{]/, description: 'object instantiation', weight: 6 },
            { pattern: /CLASSNAME\.\w+/, description: 'static member access', weight: 5 },
            { pattern: /GetComponent<CLASSNAME>/, description: 'GetComponent call', weight: 6 },
            { pattern: /HasComponent<CLASSNAME>/, description: 'HasComponent call', weight: 6 },
            { pattern: /AddComponent\([^,]*,\s*new\s+CLASSNAME(?!\w)\s*\(/, description: 'AddComponent call', weight: 6 },
            { pattern: /typeof\(CLASSNAME\)/, description: 'typeof reference', weight: 5 },
            { pattern: /\[UpdateBefore\(typeof\(CLASSNAME\)\)\]/, description: 'UpdateBefore dependency', weight: 9 },
            { pattern: /\[UpdateAfter\(typeof\(CLASSNAME\)\)\]/, description: 'UpdateAfter dependency', weight: 9 },
            { pattern: /UpdateBefore.*CLASSNAME/, description: 'UpdateBefore dependency', weight: 9 },
            { pattern: /UpdateAfter.*CLASSNAME/, description: 'UpdateAfter dependency', weight: 9 },
            { pattern: /\bCLASSNAME\b.*\s+\w+\s*[\(;]/, description: 'method parameter/variable', weight: 4 },
            { pattern: /\bCLASSNAME\b/, description: 'general reference', weight: 3 }
        ];
    }

    /**
     * INCREMENTAL: Analyze namespace dependencies for only specific objects - NO full project scan
     */
    public async analyzeSpecificNamespaces(
        workspaceRoot: string,
        targetNamespaces: string[],
        existingDependencies: Map<string, DependencyNode>
    ): Promise<Map<string, DependencyNode>> {
        const dependencies = new Map<string, DependencyNode>();
        const config = this.configManager.getConfig();
        
        // Only get files that might contain the target namespaces
        const relevantFiles = await this.getFilesForNamespaces(workspaceRoot, targetNamespaces);
        
        // Incremental namespace analysis
        
        // First pass: collect using statements for target namespaces only
        const namespaceUsings = new Map<string, Map<string, string[]>>();

        for (const filePath of relevantFiles) {
            try {
                const content = await Utils.readFileContent(filePath);
                const namespace = Utils.extractNamespace(content);
                
                // Only process if this file contains one of our target namespaces
                if (!namespace || !targetNamespaces.includes(namespace)) {
                    continue;
                }

                const usingStatements = Utils.extractUsingStatements(content);
                
                for (const usingStmt of usingStatements) {
                    const targetNamespace = usingStmt.namespace;
                    
                    // Skip ignored namespaces and self-references
                    if (Utils.shouldIgnoreNamespace(targetNamespace, config.ignoredNamespaces) ||
                        targetNamespace === namespace) {
                        continue;
                    }

                    if (!namespaceUsings.has(namespace)) {
                        namespaceUsings.set(namespace, new Map());
                    }

                    const nsMap = namespaceUsings.get(namespace)!;
                    if (!nsMap.has(targetNamespace)) {
                        nsMap.set(targetNamespace, []);
                    }

                    const relativePath = Utils.getRelativePath(filePath, workspaceRoot);
                    nsMap.get(targetNamespace)!.push(`${relativePath}:${usingStmt.lineNumber}`);
                }
            } catch (error) {
                console.warn(`Error analyzing file ${filePath}:`, error);
            }
        }

        // Build dependencies and details - only for target namespaces
        for (const [namespace, targets] of namespaceUsings) {
            if (targets.size > 0) {
                const dependencyDetails: DependencyDetail[] = [];
                const deps: string[] = [];

                for (const [target, files] of targets) {
                    deps.push(target);
                    dependencyDetails.push({
                        target,
                        reasons: files,
                        lineNumbers: files.map(f => parseInt(f.split(':')[1]) || 0)
                    });
                }

                dependencies.set(namespace, {
                    name: namespace.split('.').pop() || namespace,
                    namespace: namespace,
                    fullName: namespace,
                    filePath: '', // Namespace doesn't have a single file
                    dependencies: deps,
                    dependencyDetails,
                    classType: undefined // Namespaces don't have a specific type
                });
            }
        }

        return dependencies;
    }

    // Helper methods for incremental analysis

    private async getFilesForNamespaces(workspaceRoot: string, namespaces: string[]): Promise<string[]> {
        // For now, we'll still scan all files but this could be optimized
        // to only scan files that we know contain these namespaces
        return this.getAllCSharpFiles(workspaceRoot);
    }

    /**
     * INCREMENTAL: Analyze class dependencies for only specific objects - NO full project scan
     */
    public async analyzeSpecificClasses(
        workspaceRoot: string,
        targetClasses: string[],
        existingDependencies: Map<string, DependencyNode>
    ): Promise<Map<string, DependencyNode>> {
        const dependencies = new Map<string, DependencyNode>();
        const config = this.configManager.getConfig();
        
        // Only get files that might contain the target classes
        const relevantFiles = await this.getFilesForClasses(workspaceRoot, targetClasses);
        
        
        
        // We still need the existing class registry for lookups, but we won't rebuild it
        const allClasses = this.buildClassRegistryFromExisting(existingDependencies);
        
        // Analyze only files containing target classes
        for (const filePath of relevantFiles) {
            try {
                const content = await Utils.readFileContent(filePath);
                const namespace = Utils.extractNamespace(content) || 'Global';
                const usingStatements = Utils.extractUsingStatements(content);
                const customUsings = usingStatements
                    .filter(u => !Utils.shouldIgnoreNamespace(u.namespace, config.ignoredNamespaces))
                    .map(u => u.namespace);

                const currentFileClasses = this.extractClasses(content)
                    .filter(c => !c.isNested)
                    .map(c => ({
                        name: c.name,
                        fullName: `${namespace}.${c.name}`,
                        classInfo: c
                    }))
                    .filter(c => targetClasses.includes(c.fullName)); // Only target classes

                // For each target class in this file, find its dependencies
                for (const { name: className, fullName: fullClassName, classInfo } of currentFileClasses) {
                    const classDeps: string[] = [];
                    const classDepDetails = new Map<string, string[]>();

                    // Extract the specific scope of this class
                    const lines = content.split('\n');
                    const classScopeLines = this.extractClassScope(lines, className);

                    // Look for references to other classes (existing logic)
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

                    // CRITICAL FIX: Add ALL classes to dependencies map, not just those with outgoing dependencies
                    // This ensures "leaf" classes (structs, components, enums) appear in visualization as targets
                    if (true) { // Always add classes to dependencies map
                        const dependencyDetails: DependencyDetail[] = [];
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
            } catch (error) {
                console.warn(`Error analyzing file ${filePath}:`, error);
            }
        }

        return dependencies;
    }

    /**
     * INCREMENTAL: Analyze system dependencies for only specific objects - NO full project scan
     */
    public async analyzeSpecificSystems(
        workspaceRoot: string,
        targetSystems: string[],
        existingDependencies: Map<string, DependencyNode>
    ): Promise<Map<string, DependencyNode>> {
        const dependencies = new Map<string, DependencyNode>();
        const config = this.configManager.getConfig();
        
        // Only get files that might contain the target systems
        const relevantFiles = await this.getFilesForSystems(workspaceRoot, targetSystems);
        
        
        
        // We still need the existing system registry for lookups, but we won't rebuild it
        const allSystems = this.buildSystemRegistryFromExisting(existingDependencies);
        
        // Analyze only files containing target systems
        for (const filePath of relevantFiles) {
            try {
                const content = await Utils.readFileContent(filePath);
                const namespace = Utils.extractNamespace(content) || 'Global';
                const usingStatements = Utils.extractUsingStatements(content);
                const customUsings = usingStatements
                    .filter(u => !Utils.shouldIgnoreNamespace(u.namespace, config.ignoredNamespaces))
                    .map(u => u.namespace);

                const currentSystems = this.extractSystemClasses(content)
                    .filter(s => {
                        const fullName = `${namespace}.${s.name}`;
                        return targetSystems.includes(fullName);
                    })
                    .map(s => ({
                        name: s.name,
                        fullName: `${namespace}.${s.name}`
                    }));

                // For each target system in this file, find dependencies on other systems
                for (const { name: systemName, fullName: fullSystemName } of currentSystems) {
                    const systemDeps: string[] = [];
                    const systemDepDetails = new Map<string, string[]>();
                    const lines = content.split('\n');

                    for (const [otherSystemName, otherSystemInfo] of allSystems) {
                        if (otherSystemInfo.fullName === fullSystemName) {
                            continue;
                        }

                        // Check namespace availability
                        if (!(otherSystemInfo.namespace === namespace ||
                              customUsings.includes(otherSystemInfo.namespace) ||
                              otherSystemInfo.namespace === 'Global')) {
                            continue;
                        }

                        // Find system-specific usage patterns
                        const foundReferences = this.findSystemReferences(
                            lines,
                            otherSystemName,
                            filePath,
                            workspaceRoot
                        );

                        if (foundReferences.length > 0) {
                            systemDeps.push(otherSystemInfo.fullName);
                            systemDepDetails.set(otherSystemInfo.fullName, foundReferences);
                        }
                    }

                    // Build dependency details
                    const dependencyDetails: DependencyDetail[] = [];
                    for (const [target, reasons] of systemDepDetails) {
                        dependencyDetails.push({
                            target,
                            reasons,
                            lineNumbers: reasons.map(r => {
                                const match = r.match(/:(\d+)\)/);
                                return match ? parseInt(match[1]) : 0;
                            })
                        });
                    }

                    // Get the actual system info to determine if it's a class or struct
                    const currentSystemsInFile = this.extractSystemClasses(content);
                    const systemInfo = currentSystemsInFile.find(s => s.name === systemName);
                    const actualClassType = systemInfo?.classType || 'class';
                    
                    dependencies.set(fullSystemName, {
                        name: systemName,
                        namespace,
                        fullName: fullSystemName,
                        filePath,
                        dependencies: [...new Set(systemDeps)],
                        dependencyDetails,
                        classType: actualClassType
                    });
                }
            } catch (error) {
                console.warn(`Error analyzing file ${filePath}:`, error);
            }
        }

        return dependencies;
    }

    // Helper methods for incremental analysis
    
    private async getFilesForClasses(workspaceRoot: string, classNames: string[]): Promise<string[]> {
        // For now, we'll still scan all files but this could be optimized
        // to only scan files that we know contain these classes
        return this.getAllCSharpFiles(workspaceRoot);
    }

    private async getFilesForSystems(workspaceRoot: string, systemNames: string[]): Promise<string[]> {
        // For now, we'll still scan all files but this could be optimized
        // to only scan files that we know contain these systems
        return this.getAllCSharpFiles(workspaceRoot);
    }

    private buildClassRegistryFromExisting(existingDependencies: Map<string, DependencyNode>): Map<string, { namespace: string; fullName: string; filePath: string }> {
        const registry = new Map<string, { namespace: string; fullName: string; filePath: string }>();
        
        for (const [fullName, node] of existingDependencies) {
            const className = node.name;
            registry.set(className, {
                namespace: node.namespace,
                fullName: node.fullName,
                filePath: node.filePath
            });
        }
        
        return registry;
    }

    private buildSystemRegistryFromExisting(existingDependencies: Map<string, DependencyNode>): Map<string, { namespace: string; fullName: string; filePath: string }> {
        const registry = new Map<string, { namespace: string; fullName: string; filePath: string }>();
        
        for (const [fullName, node] of existingDependencies) {
            const systemName = node.name;
            registry.set(systemName, {
                namespace: node.namespace,
                fullName: node.fullName,
                filePath: node.filePath
            });
        }
        
        return registry;
    }
}