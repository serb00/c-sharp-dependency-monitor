import * as path from 'path';
import { Utils } from './utils';
import { ConfigManager } from './configManager';
import {
    DependencyNode,
    DependencyDetail,
    FileAnalysisResult,
    ClassInfo,
    UsingStatement,
    AnalysisResult,
    AnalysisLevel,
    DependencyPattern
} from './types';

export class DependencyAnalyzer {
    private configManager: ConfigManager;
    private dependencyPatterns: DependencyPattern[];
    private outputChannel?: any;

    constructor(outputChannel?: any) {
        this.configManager = ConfigManager.getInstance();
        this.dependencyPatterns = this.initializeDependencyPatterns();
        this.outputChannel = outputChannel;
    }

    private log(message: string) {
        if (this.outputChannel) {
            this.outputChannel.appendLine(message);
        }
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
            this.outputChannel.appendLine('⚠️  DEPRECATION WARNING: analyzeProject() called from outside the optimized cascading analysis system. For new code, please use performIncrementalCascadingAnalysis() instead.');
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

        // First pass: collect all using statements and qualified type references with file locations
        const namespaceUsings = new Map<string, Map<string, string[]>>();

        for (const filePath of allFiles) {
            try {
                const content = await Utils.readFileContent(filePath);
                const namespace = Utils.extractNamespace(content);
                
                if (!namespace) {
                    continue;
                }

                // Process using statements
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
                    nsMap.get(targetNamespace)!.push(`${relativePath}:${usingStmt.lineNumber} (using statement)`);
                }

                // CRITICAL FIX: Also process qualified type references (e.g., Combat.FindTarget)
                const qualifiedTypeRefs = Utils.extractQualifiedTypeReferences(content);
                
                for (const typeRef of qualifiedTypeRefs) {
                    const targetNamespace = typeRef.namespace;
                    
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
                    nsMap.get(targetNamespace)!.push(`${relativePath}:${typeRef.lineNumber} (${typeRef.context})`);
                }
            } catch (error) {
                this.outputChannel.appendLine(`Error analyzing file ${filePath}:`, error);
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
                this.outputChannel.appendLine(`Error analyzing file ${filePath}:`, error);
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

                    // DEBUG: Ensure we're only analyzing this specific class scope, not the entire file
                    if (fullClassName === 'Ships.Ship' || fullClassName === 'Ships.ShipAuthoring') {
                        this.outputChannel.appendLine(`🔍 DEBUG SCOPE: ${fullClassName} scope lines ${classScopeLines.length}: ${classScopeLines.map(([num, line]) => `${num}:${line.trim()}`).slice(0, 3).join(' | ')}`);
                    }

                    // CRITICAL FIX: Also process qualified type references in class scope (e.g., Combat.FindTarget)
                    const classScopeContent = classScopeLines.map(([_, line]) => line).join('\n');
                    const qualifiedTypeRefs = Utils.extractQualifiedTypeReferences(classScopeContent);
                    
                    console.log(`DEBUG: Processing ${qualifiedTypeRefs.length} qualified type references for class ${fullClassName}`);
                    
                    for (const typeRef of qualifiedTypeRefs) {
                        const targetNamespace = typeRef.namespace;
                        const typeName = typeRef.context.replace('qualified type reference to ', '');
                        const fullTargetClass = `${targetNamespace}.${typeName}`;
                        
                        console.log(`DEBUG: Looking for qualified reference: ${fullTargetClass}`);
                        console.log(`DEBUG: Available classes in registry: ${Array.from(allClasses.keys()).slice(0, 5).join(', ')}...`);
                        
                        // Check if this qualified reference points to a known class by full name
                        let found = false;
                        for (const [className, classInfo] of allClasses) {
                            if (classInfo.fullName === fullTargetClass && classInfo.fullName !== fullClassName) {
                                console.log(`DEBUG: Found match! Adding dependency: ${classInfo.fullName}`);
                                classDeps.push(classInfo.fullName);
                                const relativePath = Utils.getRelativePath(filePath, workspaceRoot);
                                if (!classDepDetails.has(classInfo.fullName)) {
                                    classDepDetails.set(classInfo.fullName, []);
                                }
                                classDepDetails.get(classInfo.fullName)!.push(`qualified type reference to ${typeName} (${relativePath}:${typeRef.lineNumber})`);
                                found = true;
                                break;
                            }
                        }
                        
                        if (!found) {
                            console.log(`DEBUG: No match found for ${fullTargetClass} in class registry`);
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

                    // DEBUG: Log details for GameConstants specifically (FULL ANALYSIS PATH)
                    if (fullClassName === 'Core.GameConstants') {
                        console.log(`🔍 DEBUG FULL: Analyzing ${fullClassName}`);
                        console.log(`🔍 DEBUG FULL: Found ${classDeps.length} dependencies: ${classDeps.join(', ')}`);
                        console.log(`🔍 DEBUG FULL: Class scope has ${classScopeLines.length} lines`);
                        console.log(`🔍 DEBUG FULL: Available classes in registry: ${Array.from(allClasses.keys()).slice(0, 10).join(', ')}`);
                        
                        const classScopeContent = classScopeLines.map(([_, line]) => line).join('\n');
                        const qualifiedTypeRefs = Utils.extractQualifiedTypeReferences(classScopeContent);
                        console.log(`🔍 DEBUG FULL: Found ${qualifiedTypeRefs.length} qualified type references: ${JSON.stringify(qualifiedTypeRefs)}`);
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
                this.outputChannel.appendLine(`Error analyzing file ${filePath}:`, error);
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
        // Use the tested utility function instead
        return Utils.extractClasses(content);
    }


    private determineClassType(line: string): 'class' | 'struct' | 'interface' | 'enum' | 'record' | 'record struct' | 'delegate' {
        // Use the tested utility function instead
        const basicType = Utils.determineClassType(line);
        
        // Handle additional types not in the basic Utils function
        if (line.includes('record struct')) return 'record struct';
        if (line.includes('record class') || (line.includes('record ') && !line.includes('record struct'))) return 'record';
        if (line.includes('delegate')) return 'delegate';
        
        return basicType as 'class' | 'struct' | 'interface' | 'enum' | 'record' | 'record struct' | 'delegate';
    }

    private isClassNested(lines: string[], classLineIndex: number, className: string): boolean {
        // Use the tested utility function instead
        return Utils.isClassNested(lines, classLineIndex, className);
    }

    private findClassEndLine(lines: string[], startLine: number): number {
        // Use the tested utility function instead
        return Utils.findClassEndLine(lines, startLine);
    }

    private extractClassScope(lines: string[], className: string): Array<[number, string]> {
        // Use the tested utility function instead
        const classScopeLines = Utils.extractClassScope(lines, className);
        
        // DEBUG: Show scope extraction results for problematic classes
        if (className === 'ShipAuthoring' || className === 'Ship' || className === 'GameConstants') {
            this.outputChannel?.appendLine(`🔍 DEBUG SCOPE: ${className} scope lines ${classScopeLines.length}: ${classScopeLines.slice(0, 3).map(([num, line]) => `${num}:${line.trim()}`).join(' | ')}`);
        }

        return classScopeLines;
    }

    private findClassReferences(
        classScopeLines: Array<[number, string]>,
        otherClassName: string,
        filePath: string,
        workspaceRoot: string
    ): string[] {
        // Use the tested utility function instead
        return Utils.findClassReferences(
            classScopeLines,
            otherClassName,
            filePath,
            workspaceRoot,
            this.dependencyPatterns
        );
    }


    private initializeDependencyPatterns(): DependencyPattern[] {
        // Get default patterns and add ECS-specific patterns
        const defaultPatterns = Utils.getDefaultDependencyPatterns();
        const ecsPatterns: DependencyPattern[] = [
            { pattern: /RefRW<CLASSNAME>/, description: 'ECS component reference (RefRW)', weight: 8 },
            { pattern: /RefRO<CLASSNAME>/, description: 'ECS component reference (RefRO)', weight: 8 },
            { pattern: /SystemAPI\..*<.*CLASSNAME.*>/, description: 'SystemAPI call', weight: 7 },
            { pattern: /GetComponent<CLASSNAME>/, description: 'GetComponent call', weight: 6 },
            { pattern: /HasComponent<CLASSNAME>/, description: 'HasComponent call', weight: 6 },
            { pattern: /AddComponent\([^,]*,\s*new\s+CLASSNAME(?!\w)\s*\(/, description: 'AddComponent call', weight: 6 },
            { pattern: /\[UpdateBefore\(typeof\(CLASSNAME\)\)\]/, description: 'UpdateBefore dependency', weight: 9 },
            { pattern: /\[UpdateAfter\(typeof\(CLASSNAME\)\)\]/, description: 'UpdateAfter dependency', weight: 9 },
            { pattern: /UpdateBefore.*CLASSNAME/, description: 'UpdateBefore dependency', weight: 9 },
            { pattern: /UpdateAfter.*CLASSNAME/, description: 'UpdateAfter dependency', weight: 9 },
            { pattern: /\bCLASSNAME\b.*\s+\w+\s*[\(;]/, description: 'method parameter/variable', weight: 4 }
        ];
        
        return [...defaultPatterns, ...ecsPatterns];
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
        
        // First pass: collect using statements and qualified type references for target namespaces only
        const namespaceUsings = new Map<string, Map<string, string[]>>();

        for (const filePath of relevantFiles) {
            try {
                const content = await Utils.readFileContent(filePath);
                const namespace = Utils.extractNamespace(content);
                
                // Only process if this file contains one of our target namespaces
                if (!namespace || !targetNamespaces.includes(namespace)) {
                    continue;
                }

                // Process using statements
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
                    nsMap.get(targetNamespace)!.push(`${relativePath}:${usingStmt.lineNumber} (using statement)`);
                }

                // CRITICAL FIX: Also process qualified type references (e.g., Combat.FindTarget)
                const qualifiedTypeRefs = Utils.extractQualifiedTypeReferences(content);
                
                for (const typeRef of qualifiedTypeRefs) {
                    const targetNamespace = typeRef.namespace;
                    
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
                    nsMap.get(targetNamespace)!.push(`${relativePath}:${typeRef.lineNumber} (${typeRef.context})`);
                }
            } catch (error) {
                this.outputChannel.appendLine(`Error analyzing file ${filePath}:`, error);
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
        // Try metadata-based optimization first
        const cacheManager = (global as any).cacheManager;
        if (cacheManager && cacheManager.fileCache) {
            const metadataIndex = Utils.createFileMetadataIndex(cacheManager.fileCache);
            const optimizedFiles = Utils.getFilesForNamespacesOptimized(namespaces, metadataIndex);
            
            if (optimizedFiles.length > 0) {
                this.log(`📊 OPTIMIZATION: Using metadata index - found ${optimizedFiles.length} relevant files for namespaces: ${namespaces.join(', ')}`);
                return optimizedFiles;
            }
        }
        
        // Fallback to full scan
        this.log(`⚠️ FALLBACK: Using full file scan for namespaces: ${namespaces.join(', ')}`);
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
                this.log(`🔍 DEBUG: Processing ${currentFileClasses.length} target classes: ${currentFileClasses.map(c => c.fullName).join(', ')}`);
                for (const { name: className, fullName: fullClassName, classInfo } of currentFileClasses) {
                    this.log(`🔍 DEBUG: Processing target class: ${fullClassName}`);
                    const classDeps: string[] = [];
                    const classDepDetails = new Map<string, string[]>();

                    // Extract the specific scope of this class
                    const lines = content.split('\n');
                    const classScopeLines = this.extractClassScope(lines, className);

                    // CRITICAL FIX: Also process qualified type references in class scope (e.g., Combat.FindTarget)
                    const classScopeContent = classScopeLines.map(([_, line]) => line).join('\n');
                    const qualifiedTypeRefs = Utils.extractQualifiedTypeReferences(classScopeContent);
                    
                    // DEBUG: Log details for GameConstants AND FindTarget specifically (INCREMENTAL PATH)
                    if (fullClassName === 'Core.GameConstants' || fullClassName === 'Combat.FindTarget') {
                        this.outputChannel.appendLine(`🔍 DEBUG: ${fullClassName} class scope has ${classScopeLines.length} lines`);
                        this.outputChannel.appendLine(`🔍 DEBUG: Class scope content sample: ${classScopeLines.slice(0, 5).map(([_, line]) => line.trim()).join(' | ')}`);
                        this.outputChannel.appendLine(`🔍 DEBUG: Found ${qualifiedTypeRefs.length} qualified type references: ${JSON.stringify(qualifiedTypeRefs)}`);
                        
                        // Show actual dependency detection results
                        this.outputChannel.appendLine(`🔍 DEBUG: Final dependencies for ${fullClassName}: [${classDeps.join(', ')}]`);
                    }
                    
                    for (const typeRef of qualifiedTypeRefs) {
                        const targetNamespace = typeRef.namespace;
                        // Extract type name from qualified reference - it's the part after the last dot
                        const qualifiedType = `${targetNamespace}.${typeRef.context.replace('qualified type reference to ', '')}`;
                        const typeName = typeRef.context.replace('qualified type reference to ', '');
                        const fullTargetClass = `${targetNamespace}.${typeName}`;
                        
                        if (fullClassName === 'Core.GameConstants') {
                            this.log(`🔍 DEBUG INCREMENTAL: Looking for qualified reference: ${fullTargetClass}`);
                        }
                        
                        // Check if this qualified reference points to a known class by full name
                        let found = false;
                        for (const [className, classInfo] of allClasses) {
                            if (classInfo.fullName === fullTargetClass && classInfo.fullName !== fullClassName) {
                                if (fullClassName === 'Core.GameConstants') {
                                    this.log(`🔍 DEBUG INCREMENTAL: Found match! Adding dependency: ${classInfo.fullName}`);
                                }
                                classDeps.push(classInfo.fullName);
                                const relativePath = Utils.getRelativePath(filePath, workspaceRoot);
                                if (!classDepDetails.has(classInfo.fullName)) {
                                    classDepDetails.set(classInfo.fullName, []);
                                }
                                classDepDetails.get(classInfo.fullName)!.push(`qualified type reference to ${typeName} (${relativePath}:${typeRef.lineNumber})`);
                                found = true;
                                break;
                            }
                        }
                        
                        if (!found && fullClassName === 'Core.GameConstants') {
                            this.log(`🔍 DEBUG INCREMENTAL: No match found for ${fullTargetClass} in class registry`);
                        }
                    }

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
                this.outputChannel.appendLine(`Error analyzing file ${filePath}:`, error);
            }
        }

        return dependencies;
    }


    // Helper methods for incremental analysis
    
    private async getFilesForClasses(workspaceRoot: string, classNames: string[]): Promise<string[]> {
        // Try metadata-based optimization first
        const cacheManager = (global as any).cacheManager;
        if (cacheManager && cacheManager.fileCache) {
            const metadataIndex = Utils.createFileMetadataIndex(cacheManager.fileCache);
            const optimizedFiles = Utils.getFilesForClassesOptimized(classNames, metadataIndex);
            
            if (optimizedFiles.length > 0) {
                this.log(`📊 OPTIMIZATION: Using metadata index - found ${optimizedFiles.length} relevant files for classes: ${classNames.join(', ')}`);
                return optimizedFiles;
            }
        }
        
        // Fallback to full scan
        this.log(`⚠️ FALLBACK: Using full file scan for classes: ${classNames.join(', ')}`);
        return this.getAllCSharpFiles(workspaceRoot);
    }

    /**
     * Smart analysis entry point that uses metadata-based optimization
     */
    public async analyzeProjectSmart(
        workspaceRoot: string,
        level?: AnalysisLevel,
        cacheManager?: any
    ): Promise<AnalysisResult & { scanMetrics?: any }> {
        const startTime = Date.now();
        const config = this.configManager.getConfig();
        const analysisLevel = level || config.level;
        
        let scanMetrics: any = null;
        let dependencies: Map<string, DependencyNode>;
        
        // Try smart analysis with metadata if cache manager is available
        if (cacheManager) {
            try {
                const lastAnalysisTime = await this.getLastAnalysisTime(cacheManager, analysisLevel);
                const smartAnalysis = await Utils.smartAnalyzeChangedFiles(
                    workspaceRoot,
                    cacheManager.fileCache || new Map(),
                    lastAnalysisTime
                );
                
                scanMetrics = smartAnalysis.scanMetrics;
                
                this.log(`📊 SMART ANALYSIS METRICS:`);
                this.log(`   Total files in workspace: ${scanMetrics.totalFiles}`);
                this.log(`   New files: ${scanMetrics.newFiles}`);
                this.log(`   Modified files: ${scanMetrics.modifiedFiles}`);
                this.log(`   Deleted files: ${scanMetrics.deletedFiles}`);
                this.log(`   Unchanged files: ${scanMetrics.unchangedFiles}`);
                this.log(`   Scan duration: ${Utils.formatDuration(scanMetrics.scanDuration)}`);
                
                if (!smartAnalysis.analysisNeeded) {
                    this.log(`✅ SMART ANALYSIS: No changes detected - using cached results`);
                    const cachedResult = await cacheManager.getCachedAnalysis(analysisLevel);
                    if (cachedResult) {
                        return { ...cachedResult, scanMetrics };
                    }
                }
                
                this.log(`🔄 SMART ANALYSIS: ${smartAnalysis.changedFiles.length} files need analysis`);
                
                // Only analyze changed files if we have a good cache
                if (smartAnalysis.changedFiles.length < scanMetrics.totalFiles * 0.5) {
                    dependencies = await this.analyzeSmartIncremental(
                        workspaceRoot,
                        analysisLevel,
                        smartAnalysis.changedFiles,
                        cacheManager
                    );
                } else {
                    this.log(`📊 Too many changes detected (${smartAnalysis.changedFiles.length}/${scanMetrics.totalFiles}) - performing full analysis`);
                    dependencies = await this.analyzeFullSmart(workspaceRoot, analysisLevel);
                }
                
            } catch (error) {
                this.log(`⚠️ Smart analysis failed, falling back to full analysis: ${error}`);
                dependencies = await this.analyzeFullSmart(workspaceRoot, analysisLevel);
            }
        } else {
            this.log(`📊 No cache manager available - performing full analysis`);
            dependencies = await this.analyzeFullSmart(workspaceRoot, analysisLevel);
        }
        
        // Get all analyzed files
        const affectedFiles = Array.from(dependencies.values()).map(dep => dep.filePath);
        const uniqueFiles = [...new Set(affectedFiles)];
        
        const result: AnalysisResult & { scanMetrics?: any } = {
            dependencies,
            circularDependencies: [], // Will be populated by CircularDependencyDetector
            analysisLevel,
            timestamp: new Date(),
            affectedFiles: uniqueFiles,
            totalFiles: uniqueFiles.length
        };
        
        if (scanMetrics) {
            result.scanMetrics = scanMetrics;
        }
        
        return result;
    }

    /**
     * Perform full analysis with smart file discovery
     */
    private async analyzeFullSmart(workspaceRoot: string, level: AnalysisLevel): Promise<Map<string, DependencyNode>> {
        switch (level) {
            case 'namespace':
                return this.analyzeNamespaceDependencies(workspaceRoot);
            case 'class':
                return this.analyzeClassDependencies(workspaceRoot);
            default:
                throw new Error(`Unsupported analysis level: ${level}`);
        }
    }

    /**
     * Perform incremental analysis using smart metadata tracking
     */
    private async analyzeSmartIncremental(
        workspaceRoot: string,
        level: AnalysisLevel,
        changedFiles: string[],
        cacheManager: any
    ): Promise<Map<string, DependencyNode>> {
        // Get existing analysis
        const existingResult = await cacheManager.getCachedAnalysis(level);
        if (!existingResult) {
            this.log(`No existing cache for incremental analysis - performing full analysis`);
            return this.analyzeFullSmart(workspaceRoot, level);
        }

        this.log(`🔄 SMART INCREMENTAL: Processing ${changedFiles.length} changed files`);
        
        // Analyze what's affected by the changed files
        const affectedItems = await this.determineAffectedItems(changedFiles, level);
        
        this.log(`📦 SMART INCREMENTAL: ${affectedItems.length} items affected`);
        
        switch (level) {
            case 'namespace':
                return this.analyzeSpecificNamespaces(workspaceRoot, affectedItems, existingResult.dependencies);
            case 'class':
                return this.analyzeSpecificClasses(workspaceRoot, affectedItems, existingResult.dependencies);
            default:
                throw new Error(`Unsupported analysis level: ${level}`);
        }
    }

    /**
     * Determine what namespaces or classes are affected by file changes
     */
    private async determineAffectedItems(changedFiles: string[], level: AnalysisLevel): Promise<string[]> {
        const affectedItems = new Set<string>();
        
        for (const filePath of changedFiles) {
            try {
                const content = await Utils.readFileContent(filePath);
                const namespace = Utils.extractNamespace(content) || 'Global';
                
                if (level === 'namespace') {
                    affectedItems.add(namespace);
                } else if (level === 'class') {
                    const classes = Utils.extractClasses(content);
                    for (const classInfo of classes) {
                        if (!classInfo.isNested) {
                            affectedItems.add(`${namespace}.${classInfo.name}`);
                        }
                    }
                }
            } catch (error) {
                this.log(`Error analyzing changed file ${filePath}: ${error}`);
            }
        }
        
        return Array.from(affectedItems);
    }

    /**
     * Get the last analysis time for optimization purposes
     */
    private async getLastAnalysisTime(cacheManager: any, level: AnalysisLevel): Promise<number | undefined> {
        try {
            const cached = await cacheManager.getCachedAnalysis(level);
            return cached?.timestamp?.getTime();
        } catch (error) {
            return undefined;
        }
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

}