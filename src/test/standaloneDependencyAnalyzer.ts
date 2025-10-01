import * as path from 'path';
import * as fs from 'fs';
import { Utils } from '../utils';

interface DependencyNode {
    name: string;
    namespace: string;
    fullName: string;
    filePath: string;
    dependencies: string[];
    dependencyDetails: DependencyDetail[];
    classType?: 'class' | 'struct' | 'interface' | 'enum' | 'record' | 'record struct' | 'delegate';
}

interface DependencyDetail {
    target: string;
    reasons: string[];
    lineNumbers: number[];
}

interface ClassInfo {
    name: string;
    fullName: string;
    namespace: string;
    isNested: boolean;
    startLine: number;
    endLine: number;
    classType: 'class' | 'struct' | 'interface' | 'enum' | 'record' | 'record struct' | 'delegate';
}

interface DependencyPattern {
    pattern: RegExp;
    description: string;
    weight: number;
}

export class StandaloneDependencyAnalyzer {
    private dependencyPatterns: DependencyPattern[];
    private outputChannel: any;

    constructor(outputChannel?: any) {
        this.dependencyPatterns = this.initializeDependencyPatterns();
        this.outputChannel = outputChannel || {
            appendLine: (message: string) => console.log(message)
        };
    }

    private log(message: string) {
        this.outputChannel.appendLine(message);
    }

    public async analyzeClassDependencies(workspaceRoot: string): Promise<Map<string, DependencyNode>> {
        const dependencies = new Map<string, DependencyNode>();
        const allFiles = await this.getAllCSharpFiles(workspaceRoot);
        const allClasses = new Map<string, { namespace: string; fullName: string; filePath: string }>();

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
            } catch (error) {
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
                    const classDeps: string[] = [];
                    const classDepDetails = new Map<string, string[]>();

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
                                classDepDetails.get(classInfo.fullName)!.push(`qualified type reference to ${typeName} (${relativePath}:${typeRef.lineNumber})`);
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
            } catch (error) {
                this.log(`Error analyzing file ${filePath}: ${error}`);
            }
        }

        return dependencies;
    }

    // Helper methods
    private async getAllCSharpFiles(workspaceRoot: string): Promise<string[]> {
        const allFiles: string[] = [];
        const scriptsPath = path.join(workspaceRoot, 'src/test/Scripts');
        
        try {
            await this.walkDirectory(scriptsPath, allFiles);
        } catch (error) {
            this.log(`Error scanning directory: ${error}`);
        }

        return allFiles.filter(file => file.endsWith('.cs') && !file.endsWith('.meta'));
    }

    private async walkDirectory(dir: string, files: string[]): Promise<void> {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await this.walkDirectory(fullPath, files);
            } else if (entry.isFile() && entry.name.endsWith('.cs')) {
                files.push(fullPath);
            }
        }
    }

    private async readFileContent(filePath: string): Promise<string> {
        return fs.readFileSync(filePath, 'utf8');
    }

    private extractNamespace(content: string): string | null {
        // Use the tested utility function instead
        return Utils.extractNamespace(content);
    }

    private extractUsingStatements(content: string): { namespace: string; lineNumber: number }[] {
        // Use the tested utility function instead
        return Utils.extractUsingStatements(content);
    }

    private extractQualifiedTypeReferences(content: string): { namespace: string; context: string; lineNumber: number }[] {
        // Use the tested utility function instead
        return Utils.extractQualifiedTypeReferences(content);
    }

    private shouldIgnoreNamespace(namespace: string): boolean {
        // Use the tested utility function instead
        const ignoredNamespaces = ['System', 'Unity', 'UnityEngine'];
        return Utils.shouldIgnoreNamespace(namespace, ignoredNamespaces);
    }

    private extractClasses(content: string): ClassInfo[] {
        // Use the tested utility function instead
        return Utils.extractClasses(content);
    }

    private determineClassType(line: string): 'class' | 'struct' | 'interface' | 'enum' | 'record' | 'record struct' | 'delegate' {
        // Use the tested utility function instead
        return Utils.determineClassType(line) as 'class' | 'struct' | 'interface' | 'enum' | 'record' | 'record struct' | 'delegate';
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
        return Utils.extractClassScope(lines, className);
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
        // Use the tested utility function instead
        return Utils.getDefaultDependencyPatterns();
    }

    private escapeRegex(str: string): string {
        // Use the tested utility function instead
        return Utils.escapeRegex(str);
    }

    private getRelativePath(filePath: string, workspaceRoot: string): string {
        // Use the tested utility function instead
        return Utils.getRelativePath(filePath, workspaceRoot);
    }
}