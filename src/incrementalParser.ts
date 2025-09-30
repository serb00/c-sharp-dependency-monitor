import * as path from 'path';
import { Utils } from './utils';
import { ConfigManager } from './configManager';
import { 
    DependencyNode, 
    DependencyDetail, 
    ClassInfo, 
    SystemInfo,
    UsingStatement, 
    AnalysisLevel 
} from './types';

/**
 * Incremental Parser for TRUE incremental analysis
 * Parses only changed files and identifies affected objects for cache updates
 */
export class IncrementalParser {
    private configManager: ConfigManager;

    constructor() {
        this.configManager = ConfigManager.getInstance();
    }

    /**
     * Parse changed file and return affected objects for each analysis level
     */
    public async parseChangedFile(filePath: string, workspaceRoot: string): Promise<{
        namespaceAffected: string[];
        classesAffected: string[];
        systemsAffected: string[];
        dependencies: {
            namespace: DependencyNode[];
            class: DependencyNode[];
            system: DependencyNode[];
        };
    }> {
        const content = await Utils.readFileContent(filePath);
        const relativePath = Utils.getRelativePath(filePath, workspaceRoot);
        
        // Extract basic file information
        const namespace = Utils.extractNamespace(content) || 'Global';
        const rawUsingStatements = Utils.extractUsingStatements(content);
        const config = this.configManager.getConfig();
        const usingStatements: UsingStatement[] = rawUsingStatements.map(u => ({
            namespace: u.namespace,
            lineNumber: u.lineNumber,
            isCustom: !Utils.shouldIgnoreNamespace(u.namespace, config.ignoredNamespaces)
        }));
        const classes = this.extractClasses(content);
        const systems = this.extractSystemClasses(content);

        const result = {
            namespaceAffected: [namespace],
            classesAffected: [] as string[],
            systemsAffected: [] as string[],
            dependencies: {
                namespace: [] as DependencyNode[],
                class: [] as DependencyNode[],
                system: [] as DependencyNode[]
            }
        };

        // 1. NAMESPACE LEVEL - Parse using statements
        const namespaceDeps = this.parseNamespaceDependencies(
            namespace,
            usingStatements,
            filePath,
            workspaceRoot,
            content
        );
        if (namespaceDeps) {
            result.dependencies.namespace.push(namespaceDeps);
        }

        // 2. CLASS LEVEL - Parse class definitions and references
        for (const classInfo of classes) {
            if (!classInfo.isNested) {
                const fullClassName = `${namespace}.${classInfo.name}`;
                result.classesAffected.push(fullClassName);
                
                const classDeps = await this.parseClassDependencies(
                    classInfo,
                    namespace,
                    content,
                    filePath,
                    workspaceRoot
                );
                if (classDeps) {
                    result.dependencies.class.push(classDeps);
                }
            }
        }

        // 3. SYSTEM LEVEL - Parse system definitions and references  
        for (const systemInfo of systems) {
            const fullSystemName = `${namespace}.${systemInfo.name}`;
            result.systemsAffected.push(fullSystemName);
            
            const systemDeps = await this.parseSystemDependencies(
                systemInfo,
                namespace,
                content,
                filePath,
                workspaceRoot
            );
            if (systemDeps) {
                result.dependencies.system.push(systemDeps);
            }
        }

        return result;
    }

    /**
     * Parse namespace-level dependencies from using statements
     */
    private parseNamespaceDependencies(
        namespace: string,
        usingStatements: UsingStatement[],
        filePath: string,
        workspaceRoot: string,
        content: string
    ): DependencyNode | null {
        const config = this.configManager.getConfig();
        const dependencyDetails: DependencyDetail[] = [];
        const dependencies: string[] = [];

        // Process using statements
        for (const usingStmt of usingStatements) {
            const targetNamespace = usingStmt.namespace;
            
            // Skip ignored namespaces and self-references
            if (Utils.shouldIgnoreNamespace(targetNamespace, config.ignoredNamespaces) ||
                targetNamespace === namespace) {
                continue;
            }

            dependencies.push(targetNamespace);
            const relativePath = Utils.getRelativePath(filePath, workspaceRoot);
            dependencyDetails.push({
                target: targetNamespace,
                reasons: [`using statement (${relativePath}:${usingStmt.lineNumber})`],
                lineNumbers: [usingStmt.lineNumber]
            });
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

            // Avoid duplicates
            if (!dependencies.includes(targetNamespace)) {
                dependencies.push(targetNamespace);
                const relativePath = Utils.getRelativePath(filePath, workspaceRoot);
                dependencyDetails.push({
                    target: targetNamespace,
                    reasons: [`${typeRef.context} (${relativePath}:${typeRef.lineNumber})`],
                    lineNumbers: [typeRef.lineNumber]
                });
            } else {
                // Add to existing dependency details
                const existing = dependencyDetails.find(d => d.target === targetNamespace);
                if (existing) {
                    const relativePath = Utils.getRelativePath(filePath, workspaceRoot);
                    existing.reasons.push(`${typeRef.context} (${relativePath}:${typeRef.lineNumber})`);
                    existing.lineNumbers.push(typeRef.lineNumber);
                }
            }
        }

        if (dependencies.length === 0) {
            return null;
        }

        return {
            name: namespace.split('.').pop() || namespace,
            namespace,
            fullName: namespace,
            filePath,
            dependencies,
            dependencyDetails
        };
    }

    /**
     * Parse class-level dependencies from class definitions and references
     */
    private async parseClassDependencies(
        classInfo: ClassInfo,
        namespace: string,
        content: string,
        filePath: string,
        workspaceRoot: string
    ): Promise<DependencyNode | null> {
        const config = this.configManager.getConfig();
        const fullClassName = `${namespace}.${classInfo.name}`;
        const dependencies: string[] = [];
        const dependencyDetails: DependencyDetail[] = [];

        // Extract class scope to analyze only this specific class
        const lines = content.split('\n');
        const classScopeLines = this.extractClassScope(lines, classInfo.name);

        // Get using statements for namespace availability check
        const rawUsingStatements = Utils.extractUsingStatements(content);
        const customUsings = rawUsingStatements
            .filter(u => !Utils.shouldIgnoreNamespace(u.namespace, config.ignoredNamespaces))
            .map(u => u.namespace);

        // Parse class references within this class scope
        // Note: This is simplified - in a full implementation, we'd need to:
        // 1. Load all known classes from cache or project scan
        // 2. Check each class for references within this scope
        // 3. Apply namespace availability rules

        // For now, we'll extract basic dependency patterns from the class scope
        const classDepDetails = new Map<string, string[]>();
        const relativePath = Utils.getRelativePath(filePath, workspaceRoot);

        // Look for common dependency patterns in class scope
        for (const [lineNumber, lineContent] of classScopeLines) {
            const foundDeps = this.extractDependencyReferencesFromLine(
                lineContent, 
                lineNumber, 
                relativePath
            );
            
            for (const [target, reason] of foundDeps) {
                if (!classDepDetails.has(target)) {
                    classDepDetails.set(target, []);
                }
                classDepDetails.get(target)!.push(reason);
            }
        }

        // Convert to dependency format
        for (const [target, reasons] of classDepDetails) {
            dependencies.push(target);
            dependencyDetails.push({
                target,
                reasons,
                lineNumbers: reasons.map(r => {
                    const match = r.match(/:(\d+)\)/);
                    return match ? parseInt(match[1]) : 0;
                })
            });
        }

        if (dependencies.length === 0) {
            return null;
        }

        return {
            name: classInfo.name,
            namespace,
            fullName: fullClassName,
            filePath,
            dependencies,
            dependencyDetails
        };
    }

    /**
     * Parse system-level dependencies from system definitions and references
     */
    private async parseSystemDependencies(
        systemInfo: SystemInfo,
        namespace: string,
        content: string,
        filePath: string,
        workspaceRoot: string
    ): Promise<DependencyNode | null> {
        const fullSystemName = `${namespace}.${systemInfo.name}`;
        const dependencies: string[] = [];
        const dependencyDetails: DependencyDetail[] = [];
        const lines = content.split('\n');
        const relativePath = Utils.getRelativePath(filePath, workspaceRoot);

        // System-specific dependency patterns
        const systemPatterns = [
            { pattern: /\[UpdateBefore\(typeof\((\w+)\)\)\]/, description: 'UpdateBefore dependency' },
            { pattern: /\[UpdateAfter\(typeof\((\w+)\)\)\]/, description: 'UpdateAfter dependency' },
            { pattern: /SystemAPI\.GetSingleton<(\w+)>/, description: 'SystemAPI singleton access' },
            { pattern: /World\.GetOrCreateSystem<(\w+)>/, description: 'system reference' },
            { pattern: /typeof\((\w+)\)/, description: 'typeof reference' }
        ];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            for (const { pattern, description } of systemPatterns) {
                const match = pattern.exec(line);
                if (match) {
                    const referencedSystem = match[1];
                    if (referencedSystem && referencedSystem !== systemInfo.name) {
                        const fullReferencedName = `${namespace}.${referencedSystem}`;
                        dependencies.push(fullReferencedName);
                        
                        dependencyDetails.push({
                            target: fullReferencedName,
                            reasons: [`${description} (${relativePath}:${i + 1})`],
                            lineNumbers: [i + 1]
                        });
                    }
                }
            }
        }

        // Always return the system node, even with no dependencies
        return {
            name: systemInfo.name,
            namespace,
            fullName: fullSystemName,
            filePath,
            dependencies,
            dependencyDetails
        };
    }

    private extractClasses(content: string): ClassInfo[] {
        const classes: ClassInfo[] = [];
        const lines = content.split('\n');

        const classPatterns = [
            /(?:public|internal|private)?\s*(?:static\s+)?(?:partial\s+)?(?:abstract\s+)?class\s+(\w+)/,
            /(?:public|internal|private)?\s*(?:static\s+)?(?:partial\s+)?(?:sealed\s+)?class\s+(\w+)/,
            /(?:public|internal|private)?\s*struct\s+(\w+)/
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
                    const isNested = this.isClassNested(lines, i, className);
                    
                    if (!isNested) {
                        classes.push({
                            name: className,
                            fullName: className,
                            namespace: '',
                            isNested: false,
                            startLine: i + 1,
                            endLine: this.findClassEndLine(lines, i),
                            classType: stripped.includes('struct') ? 'struct' : 'class'
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
            /(?:public|internal|private)?\s*(?:partial\s+)?(?:struct|class)\s+(\w+)\s*:\s*.*ISystem/
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
                        
                        systems.push({
                            name: className,
                            fullName: className,
                            namespace: '',
                            isNested: false,
                            startLine: i + 1,
                            endLine: this.findClassEndLine(lines, i),
                            classType: line.includes('struct') ? 'struct' : 'class',
                            isSystem: true,
                            systemType: line.includes('ISystem') ? 'ISystem' : 'NamedSystem'
                        });
                    }
                    break;
                }
            }
        }

        return systems;
    }

    private extractClassScope(lines: string[], className: string): Array<[number, string]> {
        const classScopeLines: Array<[number, string]> = [];
        const classPattern = new RegExp(`(?:class|struct)\\s+${Utils.escapeRegex(className)}(?:\\s*:|<|\\s+|\\s*\\{)`);

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

    private extractDependencyReferencesFromLine(
        lineContent: string, 
        lineNumber: number, 
        relativePath: string
    ): Array<[string, string]> {
        const references: Array<[string, string]> = [];
        
        // Basic patterns for class references
        const patterns = [
            { pattern: /new\s+(\w+)\s*[\(\{]/, description: 'object instantiation' },
            { pattern: /<(\w+)>/, description: 'generic type parameter' },
            { pattern: /(\w+)\.(\w+)/, description: 'static member access' },
            { pattern: /GetComponent<(\w+)>/, description: 'GetComponent call' },
            { pattern: /typeof\((\w+)\)/, description: 'typeof reference' }
        ];

        for (const { pattern, description } of patterns) {
            const match = pattern.exec(lineContent);
            if (match) {
                const referencedType = match[1];
                if (referencedType && referencedType[0].toUpperCase() === referencedType[0]) { // Likely a class name
                    references.push([
                        referencedType, 
                        `${description} (${relativePath}:${lineNumber})`
                    ]);
                }
            }
        }

        return references;
    }

    private isClassNested(lines: string[], classLineIndex: number, className: string): boolean {
        for (let j = classLineIndex - 1; j >= Math.max(0, classLineIndex - 50); j--) {
            const prevLine = lines[j].trim();
            if (!prevLine || prevLine.startsWith('//')) {
                continue;
            }

            if (/\b(?:class|struct)\s+\w+/.test(prevLine)) {
                let braceBalance = 0;
                for (let k = j; k < classLineIndex; k++) {
                    const lineToCheck = lines[k];
                    braceBalance += (lineToCheck.match(/\{/g) || []).length;
                    braceBalance -= (lineToCheck.match(/\}/g) || []).length;
                }

                if (braceBalance > 0) {
                    return true;
                } else {
                    break;
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
}