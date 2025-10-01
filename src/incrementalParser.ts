import * as path from 'path';
import { Utils } from './utils';
import { ConfigManager } from './configManager';
import {
    DependencyNode,
    DependencyDetail,
    ClassInfo,
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
        dependencies: {
            namespace: DependencyNode[];
            class: DependencyNode[];
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

        const result = {
            namespaceAffected: [namespace],
            classesAffected: [] as string[],
            dependencies: {
                namespace: [] as DependencyNode[],
                class: [] as DependencyNode[]
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
        const qualifiedTypeRefs = Utils.extractQualifiedTypeReferences(content);

        return Utils.createNamespaceDependencyNode(
            namespace,
            usingStatements,
            qualifiedTypeRefs,
            filePath,
            workspaceRoot,
            config.ignoredNamespaces
        );
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
        const dependencyPatterns = Utils.getDefaultDependencyPatterns();

        return Utils.createClassDependencyNode(
            classInfo,
            namespace,
            content,
            filePath,
            workspaceRoot,
            dependencyPatterns
        );
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
        // Use the tested utility function instead
        return Utils.isClassNested(lines, classLineIndex, className);
    }

    private findClassEndLine(lines: string[], startLine: number): number {
        // Use the tested utility function instead
        return Utils.findClassEndLine(lines, startLine);
    }
}