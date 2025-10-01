import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as fsSyncImport from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Types for C# code analysis
export interface ClassInfo {
    name: string;
    fullName: string;
    namespace: string;
    isNested: boolean;
    startLine: number;
    endLine: number;
    classType: 'class' | 'struct' | 'interface' | 'enum';
}

export interface DependencyPattern {
    pattern: RegExp;
    description: string;
    weight: number;
}

export class Utils {
    /**
     * Get all C# files in a directory recursively
     */
    static async getCSharpFiles(directoryPath: string): Promise<string[]> {
        const files: string[] = [];
        
        try {
            const entries = await fs.readdir(directoryPath, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(directoryPath, entry.name);
                
                if (entry.isDirectory()) {
                    const subFiles = await this.getCSharpFiles(fullPath);
                    files.push(...subFiles);
                } else if (entry.isFile() && entry.name.endsWith('.cs')) {
                    files.push(fullPath);
                }
            }
        } catch (error) {
            // Directory doesn't exist or is not accessible
            console.warn(`Could not read directory ${directoryPath}:`, error);
        }
        
        return files;
    }

    /**
     * Read file content safely
     */
    static async readFileContent(filePath: string): Promise<string> {
        try {
            return await fs.readFile(filePath, 'utf-8');
        } catch (error) {
            throw new Error(`Failed to read file ${filePath}: ${error}`);
        }
    }

    /**
     * Calculate MD5 checksum of file content for caching
     */
    static calculateFileChecksum(content: string): string {
        return crypto.createHash('md5').update(content).digest('hex');
    }

    /**
     * Extract namespace from C# file content
     */
    static extractNamespace(content: string): string | null {
        const namespaceMatch = content.match(/^namespace\s+([\w.]+)/m);
        return namespaceMatch ? namespaceMatch[1] : null;
    }

    /**
     * Extract using statements from C# file content
     */
    static extractUsingStatements(content: string): Array<{ namespace: string; lineNumber: number }> {
        const lines = content.split('\n');
        const usingStatements: Array<{ namespace: string; lineNumber: number }> = [];

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

    /**
     * Extract qualified type references that create namespace dependencies
     * (e.g., Combat.FindTarget in field declarations)
     */
    static extractQualifiedTypeReferences(content: string): Array<{ namespace: string; lineNumber: number; context: string }> {
        const lines = content.split('\n');
        const references: Array<{ namespace: string; lineNumber: number; context: string }> = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Skip comments and using statements (already handled)
            if (!line || line.startsWith('//') || line.startsWith('using ')) {
                continue;
            }

            // Pattern for qualified type references: Namespace.Type
            // Matches field declarations, method parameters, return types, etc.
            const qualifiedTypePattern = /\b([A-Z][a-zA-Z0-9]*(?:\.[A-Z][a-zA-Z0-9]*)+)\b/g;
            let match;

            while ((match = qualifiedTypePattern.exec(line)) !== null) {
                const qualifiedType = match[1];
                const parts = qualifiedType.split('.');
                
                // Extract namespace (all parts except the last one, which is the type name)
                if (parts.length >= 2) {
                    const namespace = parts.slice(0, -1).join('.');
                    const typeName = parts[parts.length - 1];
                    
                    references.push({
                        namespace,
                        lineNumber: i + 1,
                        context: `qualified type reference to ${typeName}`
                    });
                }
            }
        }

        return references;
    }

    /**
     * Check if a namespace should be ignored (System, Unity, etc.)
     */
    static shouldIgnoreNamespace(namespace: string, ignoredNamespaces: string[]): boolean {
        return ignoredNamespaces.some(ignored => namespace.startsWith(ignored));
    }

    /**
     * Convert file path to relative path from workspace root
     */
    static getRelativePath(filePath: string, workspaceRoot?: string): string {
        if (!workspaceRoot || !vscode.workspace.workspaceFolders) {
            return path.basename(filePath);
        }

        // Find the workspace folder that contains this file
        for (const folder of vscode.workspace.workspaceFolders) {
            const folderPath = folder.uri.fsPath;
            if (filePath.startsWith(folderPath)) {
                return path.relative(folderPath, filePath);
            }
        }

        // If not in workspace, try the provided workspace root
        if (filePath.startsWith(workspaceRoot)) {
            return path.relative(workspaceRoot, filePath);
        }

        return path.basename(filePath);
    }

    /**
     * Generate unique ID for circular dependency
     */
    static generateCircularDependencyId(cycle: string[]): string {
        // Sort to ensure consistent ID regardless of cycle start point
        const sortedCycle = [...cycle].sort();
        return crypto.createHash('sha256')
            .update(sortedCycle.join('->'))
            .digest('hex')
            .substring(0, 16);
    }

    /**
     * Escape string for regex usage
     */
    static escapeRegex(string: string): string {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Deep clone an object
     */
    static deepClone<T>(obj: T): T {
        return JSON.parse(JSON.stringify(obj));
    }

    /**
     * Debounce function for file watching
     */
    static debounce<T extends (...args: any[]) => void>(
        func: T,
        wait: number
    ): (...args: Parameters<T>) => void {
        let timeout: NodeJS.Timeout;
        
        return (...args: Parameters<T>) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => func(...args), wait);
        };
    }

    /**
     * Get workspace root path
     */
    static getWorkspaceRoot(): string | undefined {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        return workspaceFolders?.[0]?.uri.fsPath;
    }

    /**
     * Show error message with optional actions
     */
    static async showErrorMessage(
        message: string, 
        ...actions: string[]
    ): Promise<string | undefined> {
        return vscode.window.showErrorMessage(message, ...actions);
    }

    /**
     * Show info message with optional actions
     */
    static async showInfoMessage(
        message: string,
        ...actions: string[]
    ): Promise<string | undefined> {
        return vscode.window.showInformationMessage(message, ...actions);
    }

    /**
     * Show warning message with optional actions
     */
    static async showWarningMessage(
        message: string,
        ...actions: string[]
    ): Promise<string | undefined> {
        return vscode.window.showWarningMessage(message, ...actions);
    }

    /**
     * Format time duration for display
     */
    static formatDuration(milliseconds: number): string {
        if (milliseconds < 1000) {
            return `${milliseconds}ms`;
        } else if (milliseconds < 60000) {
            return `${(milliseconds / 1000).toFixed(1)}s`;
        } else {
            const minutes = Math.floor(milliseconds / 60000);
            const seconds = Math.floor((milliseconds % 60000) / 1000);
            return `${minutes}m ${seconds}s`;
        }
    }

    /**
     * Check if file exists
     */
    static async fileExists(filePath: string): Promise<boolean> {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    // ========================================
    // GRAPH DISCOVERY FUNCTIONS
    // ========================================

    /**
     * Extract all classes from C# file content with comprehensive parsing
     */
    static extractClasses(content: string): ClassInfo[] {
        const classes: ClassInfo[] = [];
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

    /**
     * Determine the type of a C# class/struct/interface/enum
     */
    static determineClassType(line: string): 'class' | 'struct' | 'interface' | 'enum' {
        if (line.includes('struct')) return 'struct';
        if (line.includes('interface')) return 'interface';
        if (line.includes('enum')) return 'enum';
        return 'class';
    }

    /**
     * Check if a class is nested within another class
     */
    static isClassNested(lines: string[], classLineIndex: number, className: string): boolean {
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

    /**
     * Find the end line of a class definition
     */
    static findClassEndLine(lines: string[], startLine: number): number {
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

    /**
     * Extract the scope (content) of a specific class
     */
    static extractClassScope(lines: string[], className: string): Array<[number, string]> {
        const classScopeLines: Array<[number, string]> = [];
        
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

    /**
     * Get all C# files using synchronous file operations for compatibility
     */
    static getAllCSharpFilesSync(workspaceRoot: string): string[] {
        const allFiles: string[] = [];
        
        try {
            this.walkDirectorySync(workspaceRoot, allFiles);
        } catch (error) {
            console.warn(`Error scanning directory: ${error}`);
        }

        return allFiles.filter(file => file.endsWith('.cs') && !file.endsWith('.meta'));
    }

    /**
     * Recursively walk directory structure synchronously
     */
    static walkDirectorySync(dir: string, files: string[]): void {
        const entries = fsSyncImport.readdirSync(dir, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                this.walkDirectorySync(fullPath, files);
            } else if (entry.isFile() && entry.name.endsWith('.cs')) {
                files.push(fullPath);
            }
        }
    }

    /**
     * Read file content synchronously for compatibility
     */
    static readFileContentSync(filePath: string): string {
        return fsSyncImport.readFileSync(filePath, 'utf8');
    }

    // ========================================
    // GRAPH ANALYSIS FUNCTIONS  
    // ========================================

    /**
     * Default dependency patterns for C# code analysis
     */
    static getDefaultDependencyPatterns(): DependencyPattern[] {
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

    /**
     * Find class references in specific lines using dependency patterns
     */
    static findClassReferences(
        classScopeLines: Array<[number, string]>, 
        targetClassName: string, 
        filePath: string,
        workspaceRoot: string,
        dependencyPatterns?: DependencyPattern[]
    ): string[] {
        const references: string[] = [];
        const relativePath = path.relative(workspaceRoot, filePath);
        const patterns = dependencyPatterns || this.getDefaultDependencyPatterns();

        for (const [lineNumber, lineContent] of classScopeLines) {
            // Skip comments and string literals for dependency detection
            const trimmedLine = lineContent.trim();
            
            // Skip comment lines
            if (trimmedLine.startsWith('//') || trimmedLine.startsWith('*') || trimmedLine.startsWith('/*')) {
                continue;
            }
            
            // Skip string literals containing class names - improved regex
            if (new RegExp(`"[^"]*\\b${this.escapeRegex(targetClassName)}\\b[^"]*"`).test(lineContent)) {
                continue;
            }
            
            for (const pattern of patterns) {
                const regex = new RegExp(pattern.pattern.source.replace(/CLASSNAME/g, this.escapeRegex(targetClassName)));
                if (regex.test(lineContent)) {
                    references.push(`${pattern.description} (${relativePath}:${lineNumber})`);
                    break;
                }
            }
        }

        return references;
    }

    /**
     * Extract enhanced qualified type references with better filtering
     */
    static extractQualifiedTypeReferencesEnhanced(content: string): Array<{ namespace: string; lineNumber: number; context: string }> {
        const lines = content.split('\n');
        const qualifiedRefs: Array<{ namespace: string; lineNumber: number; context: string }> = [];
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

    // ========================================
    // CIRCULAR DEPENDENCY DETECTION
    // ========================================

    /**
     * Find circular dependencies in a dependency graph
     */
    static findCircularDependencies(dependencies: Map<string, any>): Array<{ cycle: string[]; description: string }> {
        const visited = new Set<string>();
        const recStack = new Set<string>();
        const cycles: string[][] = [];
        
        const dfs = (node: string, path: string[]) => {
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

    // ============================
    // GRAPH PERSISTENCE FUNCTIONS
    // ============================

    /**
     * Serialize dependency graph to JSON format for caching
     */
    static serializeDependencyGraph(dependencies: Map<string, any>): any {
        return {
            dependencies: Array.from(dependencies.entries()),
            timestamp: Date.now(),
            version: '1.0.0'
        };
    }

    /**
     * Deserialize dependency graph from JSON format
     */
    static deserializeDependencyGraph(data: any): Map<string, any> {
        if (!data || !data.dependencies) {
            return new Map();
        }
        return new Map(data.dependencies);
    }

    /**
     * Calculate simple content hash for file content (used for cache invalidation)
     */
    static calculateContentHash(content: string): string {
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return hash.toString();
    }

    /**
     * Calculate file hash from file path
     */
    static async calculateFileHash(filePath: string): Promise<string> {
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            return this.calculateContentHash(content);
        } catch (error) {
            throw new Error(`Failed to calculate hash for ${filePath}: ${error}`);
        }
    }

    /**
     * Calculate hashes for multiple dependency nodes
     */
    static async calculateDependencyFileHashes(dependencies: Map<string, any>): Promise<Map<string, string>> {
        const hashes = new Map<string, string>();

        for (const [_, node] of dependencies) {
            if (node.filePath) {
                try {
                    const hash = await this.calculateFileHash(node.filePath);
                    hashes.set(node.filePath, hash);
                } catch (error) {
                    // File might not exist anymore, skip
                }
            }
        }

        return hashes;
    }

    /**
     * Validate cache against file changes
     */
    static async validateCacheHashes(
        cachedHashes: Map<string, string>,
        changedFiles: string[]
    ): Promise<boolean> {
        try {
            for (const filePath of changedFiles) {
                const currentHash = await this.calculateFileHash(filePath);
                const cachedHash = cachedHashes.get(filePath);

                if (cachedHash && cachedHash !== currentHash) {
                    return false; // File changed
                }
            }
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Find files that depend on changed files (dependency-based invalidation)
     */
    static findDependentFiles(
        changedFilePath: string,
        fileCache: Map<string, { dependencies: string[]; namespace: string; classes: string[] }>
    ): string[] {
        const dependents: string[] = [];
        
        // Get namespace and classes from the changed file
        const fileData = fileCache.get(changedFilePath);
        if (!fileData) {
            return dependents;
        }

        // Find files that depend on this file's namespace or classes
        for (const [otherPath, otherData] of fileCache) {
            if (otherPath === changedFilePath) continue;

            // Check if other file depends on this file's namespace
            if (otherData.dependencies.includes(fileData.namespace)) {
                dependents.push(otherPath);
                continue;
            }

            // Check if other file depends on this file's classes
            for (const className of fileData.classes) {
                if (otherData.dependencies.includes(className)) {
                    dependents.push(otherPath);
                    break;
                }
            }
        }

        return dependents;
    }

    /**
     * Merge incremental analysis results with existing dependency graph
     */
    static mergeDependencyGraphs(
        existing: Map<string, any>,
        incremental: Map<string, any>,
        affectedKeys: string[]
    ): Map<string, any> {
        const merged = new Map(existing);

        // Update affected nodes
        for (const key of affectedKeys) {
            if (incremental.has(key)) {
                merged.set(key, incremental.get(key));
            } else {
                // If key not in incremental result, remove it (file might have been deleted)
                merged.delete(key);
            }
        }

        // Add any new nodes from incremental analysis
        for (const [key, value] of incremental) {
            if (!affectedKeys.includes(key)) {
                merged.set(key, value);
            }
        }

        return merged;
    }

    /**
     * Extract metadata from dependency graph for caching
     */
    static extractGraphMetadata(dependencies: Map<string, any>, analysisLevel: string): any {
        const allFiles = new Set<string>();
        const allNamespaces = new Set<string>();
        
        for (const [_, node] of dependencies) {
            if (node.filePath) allFiles.add(node.filePath);
            if (node.namespace) allNamespaces.add(node.namespace);
        }

        return {
            totalDependencies: dependencies.size,
            totalFiles: allFiles.size,
            totalNamespaces: allNamespaces.size,
            analysisLevel,
            timestamp: Date.now(),
            fileList: Array.from(allFiles),
            namespaceList: Array.from(allNamespaces)
        };
    }

    // ========================================
    // INCREMENTAL UPDATE FUNCTIONS
    // ========================================

    /**
     * Check if cache is valid based on file changes
     */
    static async validateCacheWithFileChanges(
        cachedFileHashes: Map<string, string>,
        changedFiles: string[]
    ): Promise<boolean> {
        try {
            for (const filePath of changedFiles) {
                const currentHash = await this.calculateFileHash(filePath);
                const cachedHash = cachedFileHashes.get(filePath);

                if (cachedHash && cachedHash !== currentHash) {
                    return false; // File changed
                }
            }
            return true;
        } catch (error) {
            console.warn(`Error validating cache: ${error}`);
            return false;
        }
    }

    /**
     * Calculate hashes for multiple files in a dependency graph
     */
    static async calculateFileHashesForGraph(dependencies: Map<string, any>): Promise<Map<string, string>> {
        const hashes = new Map<string, string>();

        for (const [_, node] of dependencies) {
            if (node.filePath) {
                try {
                    const hash = await this.calculateFileHash(node.filePath);
                    hashes.set(node.filePath, hash);
                } catch (error) {
                    // File might not exist anymore, skip
                    console.warn(`Failed to hash file ${node.filePath}: ${error}`);
                }
            }
        }

        return hashes;
    }

    /**
     * Create file cache entry with analysis data
     */
    static createFileCacheEntry(
        filePath: string,
        hash: string,
        lastModified: number,
        namespace: string,
        classes: string[],
        dependencies: string[]
    ): {
        filePath: string;
        hash: string;
        lastModified: number;
        namespace: string;
        classes: string[];
        dependencies: string[];
        lastAnalyzed: number;
    } {
        return {
            filePath,
            hash,
            lastModified,
            namespace,
            classes,
            dependencies,
            lastAnalyzed: Date.now()
        };
    }

    /**
     * Identify files that depend on a changed file based on namespace and class references
     */
    static findDependentFilesFromCache(
        changedFilePath: string,
        changedFileNamespace: string,
        changedFileClasses: string[],
        fileCache: Map<string, any>
    ): string[] {
        const dependents: string[] = [];

        for (const [otherPath, otherData] of fileCache) {
            if (otherPath === changedFilePath) continue;

            // Check if other file depends on this file's namespace
            if (otherData.dependencies && otherData.dependencies.includes(changedFileNamespace)) {
                dependents.push(otherPath);
                continue;
            }

            // Check if other file depends on this file's classes
            if (otherData.dependencies && changedFileClasses.some(className => 
                otherData.dependencies.includes(className)
            )) {
                dependents.push(otherPath);
            }
        }

        return dependents;
    }

    /**
     * Invalidate cache entries for files and their dependents
     */
    static invalidateFilesAndDependents(
        filePaths: string[],
        fileCache: Map<string, any>
    ): { invalidatedFiles: string[]; dependentFiles: string[] } {
        const invalidatedFiles: string[] = [];
        const dependentFiles = new Set<string>();

        for (const filePath of filePaths) {
            // Get file data before removal
            const fileData = fileCache.get(filePath);
            
            // Remove from file cache
            if (fileCache.has(filePath)) {
                fileCache.delete(filePath);
                invalidatedFiles.push(filePath);
            }

            // Find dependent files if we had cached data
            if (fileData) {
                const deps = this.findDependentFilesFromCache(
                    filePath,
                    fileData.namespace || '',
                    fileData.classes || [],
                    fileCache
                );
                deps.forEach(dep => dependentFiles.add(dep));
            }
        }

        // Invalidate dependent files as well
        for (const depFile of dependentFiles) {
            if (fileCache.has(depFile)) {
                fileCache.delete(depFile);
                invalidatedFiles.push(depFile);
            }
        }

        return {
            invalidatedFiles,
            dependentFiles: Array.from(dependentFiles)
        };
    }

    /**
     * Parse a single changed file and return incremental update information
     */
    static async parseChangedFileIncremental(
        filePath: string,
        content: string,
        workspaceRoot: string,
        ignoredNamespaces: string[] = ['System', 'Unity', 'UnityEngine']
    ): Promise<{
        namespaceAffected: string[];
        classesAffected: string[];
        namespace: string;
        classes: string[];
        usingStatements: Array<{ namespace: string; lineNumber: number }>;
        qualifiedTypeRefs: Array<{ namespace: string; lineNumber: number; context: string }>;
    }> {
        // Extract basic file information
        const namespace = this.extractNamespace(content) || 'Global';
        const usingStatements = this.extractUsingStatements(content);
        const qualifiedTypeRefs = this.extractQualifiedTypeReferences(content);
        const classes = this.extractClasses(content);

        // Build affected items
        const namespaceAffected = [namespace];
        const classesAffected: string[] = [];
        const classNames: string[] = [];

        for (const classInfo of classes) {
            if (!classInfo.isNested) {
                const fullClassName = `${namespace}.${classInfo.name}`;
                classesAffected.push(fullClassName);
                classNames.push(classInfo.name);
            }
        }

        return {
            namespaceAffected,
            classesAffected,
            namespace,
            classes: classNames,
            usingStatements,
            qualifiedTypeRefs
        };
    }

    /**
     * Create namespace-level dependency node from incremental analysis
     */
    static createNamespaceDependencyNode(
        namespace: string,
        usingStatements: Array<{ namespace: string; lineNumber: number }>,
        qualifiedTypeRefs: Array<{ namespace: string; lineNumber: number; context: string }>,
        filePath: string,
        workspaceRoot: string,
        ignoredNamespaces: string[] = ['System', 'Unity', 'UnityEngine']
    ): any | null {
        const dependencies: string[] = [];
        const dependencyDetails: any[] = [];

        // Process using statements
        for (const usingStmt of usingStatements) {
            const targetNamespace = usingStmt.namespace;
            
            // Skip ignored namespaces and self-references
            if (this.shouldIgnoreNamespace(targetNamespace, ignoredNamespaces) ||
                targetNamespace === namespace) {
                continue;
            }

            dependencies.push(targetNamespace);
            const relativePath = this.getRelativePath(filePath, workspaceRoot);
            dependencyDetails.push({
                target: targetNamespace,
                reasons: [`using statement (${relativePath}:${usingStmt.lineNumber})`],
                lineNumbers: [usingStmt.lineNumber]
            });
        }

        // Process qualified type references
        for (const typeRef of qualifiedTypeRefs) {
            const targetNamespace = typeRef.namespace;
            
            // Skip ignored namespaces and self-references
            if (this.shouldIgnoreNamespace(targetNamespace, ignoredNamespaces) ||
                targetNamespace === namespace) {
                continue;
            }

            // Avoid duplicates
            if (!dependencies.includes(targetNamespace)) {
                dependencies.push(targetNamespace);
                const relativePath = this.getRelativePath(filePath, workspaceRoot);
                dependencyDetails.push({
                    target: targetNamespace,
                    reasons: [`${typeRef.context} (${relativePath}:${typeRef.lineNumber})`],
                    lineNumbers: [typeRef.lineNumber]
                });
            } else {
                // Add to existing dependency details
                const existing = dependencyDetails.find(d => d.target === targetNamespace);
                if (existing) {
                    const relativePath = this.getRelativePath(filePath, workspaceRoot);
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
     * Create class-level dependency node from incremental analysis
     */
    static createClassDependencyNode(
        classInfo: any,
        namespace: string,
        content: string,
        filePath: string,
        workspaceRoot: string,
        dependencyPatterns: Array<{ pattern: RegExp; description: string; weight: number }> = []
    ): any | null {
        const fullClassName = `${namespace}.${classInfo.name}`;
        const dependencies: string[] = [];
        const dependencyDetails: any[] = [];

        // Extract class scope to analyze only this specific class
        const lines = content.split('\n');
        const classScopeLines = this.extractClassScope(lines, classInfo.name);

        // Use default patterns if none provided
        const patterns = dependencyPatterns.length > 0 ? dependencyPatterns : this.getDefaultDependencyPatterns();

        // Look for dependency patterns in class scope
        const classDepDetails = new Map<string, string[]>();
        const relativePath = this.getRelativePath(filePath, workspaceRoot);

        for (const [lineNumber, lineContent] of classScopeLines) {
            // Skip comments and string literals
            const trimmedLine = lineContent.trim();
            if (trimmedLine.startsWith('//') || trimmedLine.startsWith('*') || trimmedLine.startsWith('/*')) {
                continue;
            }

            // Extract dependency references from this line
            const foundDeps = this.extractDependencyReferencesFromLine(
                lineContent, 
                lineNumber, 
                relativePath,
                patterns
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
            dependencyDetails,
            classType: classInfo.classType
        };
    }

    /**
     * Extract dependency references from a single line of code
     */
    static extractDependencyReferencesFromLine(
        lineContent: string,
        lineNumber: number,
        relativePath: string,
        patterns: Array<{ pattern: RegExp; description: string; weight: number }> = []
    ): Array<[string, string]> {
        const references: Array<[string, string]> = [];
        
        // Use default patterns if none provided
        const patternsToUse = patterns.length > 0 ? patterns : this.getDefaultDependencyPatterns();

        for (const { pattern, description } of patternsToUse) {
            // Create a working pattern by replacing CLASSNAME placeholder
            const workingPattern = new RegExp(pattern.source.replace(/CLASSNAME/g, '(\\w+)'), 'g');
            const matches = lineContent.matchAll(workingPattern);
            
            for (const match of matches) {
                if (match[1]) { // The class name should be in the first capture group
                    const referencedType = match[1];
                    // Basic check if it looks like a class name (starts with uppercase)
                    if (referencedType && referencedType[0].toUpperCase() === referencedType[0]) {
                        references.push([
                            referencedType, 
                            `${description} (${relativePath}:${lineNumber})`
                        ]);
                    }
                }
            }
        }

        return references;
    }

    /**
     * Update dependency graph with incremental changes
     */
    static updateGraphIncremental(
        existingGraph: Map<string, any>,
        newNodes: any[],
        removedNodeKeys: string[] = []
    ): Map<string, any> {
        const updatedGraph = new Map(existingGraph);

        // Remove deleted nodes
        for (const key of removedNodeKeys) {
            updatedGraph.delete(key);
        }

        // Add or update new nodes
        for (const node of newNodes) {
            if (node && node.fullName) {
                updatedGraph.set(node.fullName, node);
            }
        }

        return updatedGraph;
    }

    /**
     * Check if incremental update is possible or if full rebuild is needed
     */
    static shouldUseIncrementalUpdate(
        changedFiles: string[],
        totalFiles: number,
        maxIncrementalThreshold: number = 0.1 // 10% of files
    ): boolean {
        const changeRatio = changedFiles.length / totalFiles;
        return changeRatio <= maxIncrementalThreshold;
    }

    /**
     * Calculate file statistics (for file watching and last modified timestamps)
     */
    static async getFileStats(filePath: string): Promise<{ lastModified: number; size: number } | null> {
        try {
            const stats = await fs.stat(filePath);
            return {
                lastModified: stats.mtime.getTime(),
                size: stats.size
            };
        } catch (error) {
            return null;
        }
    }

    // ========================================
    // METADATA-BASED ANALYSIS FUNCTIONS
    // ========================================

    /**
     * Get all C# files with metadata (last modified, size) for efficient change detection
     */
    static async getCSharpFilesWithMetadata(
        directoryPath: string,
        lastScanTime?: number
    ): Promise<Array<{
        filePath: string;
        lastModified: number;
        size: number;
        isNew: boolean;
        isModified: boolean;
    }>> {
        const filesWithMetadata: Array<{
            filePath: string;
            lastModified: number;
            size: number;
            isNew: boolean;
            isModified: boolean;
        }> = [];
        
        try {
            await this.walkDirectoryWithMetadata(directoryPath, filesWithMetadata, lastScanTime);
        } catch (error) {
            console.warn(`Could not read directory ${directoryPath}:`, error);
        }
        
        return filesWithMetadata.filter(file =>
            file.filePath.endsWith('.cs') && !file.filePath.endsWith('.meta')
        );
    }

    /**
     * Recursively walk directory and collect file metadata
     */
    static async walkDirectoryWithMetadata(
        dir: string,
        files: Array<{
            filePath: string;
            lastModified: number;
            size: number;
            isNew: boolean;
            isModified: boolean;
        }>,
        lastScanTime?: number
    ): Promise<void> {
        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                
                if (entry.isDirectory()) {
                    await this.walkDirectoryWithMetadata(fullPath, files, lastScanTime);
                } else if (entry.isFile() && entry.name.endsWith('.cs')) {
                    const stats = await this.getFileStats(fullPath);
                    if (stats) {
                        const isNew = !lastScanTime;
                        const isModified = lastScanTime ? stats.lastModified > lastScanTime : false;
                        
                        files.push({
                            filePath: fullPath,
                            lastModified: stats.lastModified,
                            size: stats.size,
                            isNew,
                            isModified
                        });
                    }
                }
            }
        } catch (error) {
            console.warn(`Could not scan directory ${dir}:`, error);
        }
    }

    /**
     * Identify files that need analysis based on metadata comparison
     */
    static identifyFilesNeedingAnalysis(
        currentFiles: Array<{
            filePath: string;
            lastModified: number;
            size: number;
            isNew: boolean;
            isModified: boolean;
        }>,
        fileCache: Map<string, any>
    ): {
        newFiles: string[];
        modifiedFiles: string[];
        deletedFiles: string[];
        unchangedFiles: string[];
    } {
        const newFiles: string[] = [];
        const modifiedFiles: string[] = [];
        const unchangedFiles: string[] = [];
        const currentFilePaths = new Set(currentFiles.map(f => f.filePath));
        
        // Check for new and modified files
        for (const file of currentFiles) {
            const cached = fileCache.get(file.filePath);
            
            if (!cached) {
                newFiles.push(file.filePath);
            } else if (cached.lastModified !== file.lastModified || cached.size !== file.size) {
                modifiedFiles.push(file.filePath);
            } else {
                unchangedFiles.push(file.filePath);
            }
        }
        
        // Check for deleted files
        const deletedFiles: string[] = [];
        for (const [cachedPath] of fileCache) {
            if (!currentFilePaths.has(cachedPath)) {
                deletedFiles.push(cachedPath);
            }
        }
        
        return {
            newFiles,
            modifiedFiles,
            deletedFiles,
            unchangedFiles
        };
    }

    /**
     * Smart file scanning that only reads files that have changed since last analysis
     */
    static async smartAnalyzeChangedFiles(
        workspaceRoot: string,
        fileCache: Map<string, any>,
        lastAnalysisTime?: number
    ): Promise<{
        changedFiles: string[];
        unchangedFiles: string[];
        analysisNeeded: boolean;
        scanMetrics: {
            totalFiles: number;
            newFiles: number;
            modifiedFiles: number;
            deletedFiles: number;
            unchangedFiles: number;
            scanDuration: number;
        };
    }> {
        const startTime = Date.now();
        
        // Get all files with metadata
        const currentFiles = await this.getCSharpFilesWithMetadata(workspaceRoot, lastAnalysisTime);
        
        // Identify what needs analysis
        const analysis = this.identifyFilesNeedingAnalysis(currentFiles, fileCache);
        
        const changedFiles = [...analysis.newFiles, ...analysis.modifiedFiles];
        const analysisNeeded = changedFiles.length > 0 || analysis.deletedFiles.length > 0;
        
        const scanDuration = Date.now() - startTime;
        
        return {
            changedFiles,
            unchangedFiles: analysis.unchangedFiles,
            analysisNeeded,
            scanMetrics: {
                totalFiles: currentFiles.length,
                newFiles: analysis.newFiles.length,
                modifiedFiles: analysis.modifiedFiles.length,
                deletedFiles: analysis.deletedFiles.length,
                unchangedFiles: analysis.unchangedFiles.length,
                scanDuration
            }
        };
    }

    /**
     * Update file metadata cache with bulk file information
     */
    static async updateFileMetadataCache(
        fileMetadata: Array<{
            filePath: string;
            lastModified: number;
            size: number;
            isNew: boolean;
            isModified: boolean;
        }>,
        fileCache: Map<string, any>
    ): Promise<void> {
        for (const file of fileMetadata) {
            const existingEntry = fileCache.get(file.filePath);
            
            if (existingEntry) {
                // Update existing entry with new metadata
                existingEntry.lastModified = file.lastModified;
                existingEntry.size = file.size;
                existingEntry.lastAnalyzed = Date.now();
            }
            // Note: New files will be added to cache when they're actually analyzed
        }
    }

    /**
     * Create file metadata index for fast lookups
     */
    static createFileMetadataIndex(
        fileCache: Map<string, any>
    ): {
        byNamespace: Map<string, string[]>;
        byClass: Map<string, string[]>;
        byLastModified: Map<number, string[]>;
        totalFiles: number;
    } {
        const byNamespace = new Map<string, string[]>();
        const byClass = new Map<string, string[]>();
        const byLastModified = new Map<number, string[]>();
        
        for (const [filePath, fileData] of fileCache) {
            // Index by namespace
            if (fileData.namespace) {
                if (!byNamespace.has(fileData.namespace)) {
                    byNamespace.set(fileData.namespace, []);
                }
                byNamespace.get(fileData.namespace)!.push(filePath);
            }
            
            // Index by classes
            if (fileData.classes) {
                for (const className of fileData.classes) {
                    if (!byClass.has(className)) {
                        byClass.set(className, []);
                    }
                    byClass.get(className)!.push(filePath);
                }
            }
            
            // Index by modification time (rounded to minutes for grouping)
            const modifiedMinute = Math.floor(fileData.lastModified / 60000) * 60000;
            if (!byLastModified.has(modifiedMinute)) {
                byLastModified.set(modifiedMinute, []);
            }
            byLastModified.get(modifiedMinute)!.push(filePath);
        }
        
        return {
            byNamespace,
            byClass,
            byLastModified,
            totalFiles: fileCache.size
        };
    }

    /**
     * Get files that likely contain specific namespaces (optimization for incremental analysis)
     */
    static getFilesForNamespacesOptimized(
        targetNamespaces: string[],
        fileMetadataIndex: { byNamespace: Map<string, string[]>; byClass: Map<string, string[]> }
    ): string[] {
        const relevantFiles = new Set<string>();
        
        for (const namespace of targetNamespaces) {
            // Direct namespace match
            const directFiles = fileMetadataIndex.byNamespace.get(namespace);
            if (directFiles) {
                directFiles.forEach(file => relevantFiles.add(file));
            }
            
            // Partial namespace matches (e.g., "Combat" matches "Combat.Systems")
            for (const [cachedNamespace, files] of fileMetadataIndex.byNamespace) {
                if (cachedNamespace.startsWith(namespace + '.') || namespace.startsWith(cachedNamespace + '.')) {
                    files.forEach(file => relevantFiles.add(file));
                }
            }
        }
        
        return Array.from(relevantFiles);
    }

    /**
     * Get files that likely contain specific classes (optimization for incremental analysis)
     */
    static getFilesForClassesOptimized(
        targetClasses: string[],
        fileMetadataIndex: { byNamespace: Map<string, string[]>; byClass: Map<string, string[]> }
    ): string[] {
        const relevantFiles = new Set<string>();
        
        for (const fullClassName of targetClasses) {
            // Extract class name from full name (e.g., "Combat.FindTarget" -> "FindTarget")
            const className = fullClassName.split('.').pop() || fullClassName;
            
            // Direct class match
            const directFiles = fileMetadataIndex.byClass.get(className);
            if (directFiles) {
                directFiles.forEach(file => relevantFiles.add(file));
            }
            
            // Also check by namespace if full class name provided
            if (fullClassName.includes('.')) {
                const namespace = fullClassName.substring(0, fullClassName.lastIndexOf('.'));
                const namespaceFiles = fileMetadataIndex.byNamespace.get(namespace);
                if (namespaceFiles) {
                    namespaceFiles.forEach(file => relevantFiles.add(file));
                }
            }
        }
        
        return Array.from(relevantFiles);
    }

    /**
     * Calculate analysis efficiency metrics
     */
    static calculateAnalysisEfficiency(
        totalFilesInWorkspace: number,
        filesActuallyAnalyzed: number,
        scanDuration: number,
        analysisDuration: number
    ): {
        efficiencyRatio: number;
        filesSkipped: number;
        timeSkipped: number;
        totalDuration: number;
        recommendation: string;
    } {
        const efficiencyRatio = filesActuallyAnalyzed / totalFilesInWorkspace;
        const filesSkipped = totalFilesInWorkspace - filesActuallyAnalyzed;
        const timeSkipped = scanDuration * (filesSkipped / totalFilesInWorkspace);
        const totalDuration = scanDuration + analysisDuration;
        
        let recommendation = 'optimal';
        if (efficiencyRatio > 0.8) {
            recommendation = 'consider full analysis';
        } else if (efficiencyRatio < 0.1) {
            recommendation = 'excellent optimization';
        } else if (efficiencyRatio < 0.3) {
            recommendation = 'good optimization';
        }
        
        return {
            efficiencyRatio,
            filesSkipped,
            timeSkipped,
            totalDuration,
            recommendation
        };
    }

    /**
     * Unified cache invalidation strategy for both namespace and class levels
     */
    static invalidateUnifiedCache(
        changedFiles: string[],
        fileCache: Map<string, any>,
        memoryCache: Map<string, any>
    ): {
        invalidatedFiles: string[];
        dependentFiles: string[];
        clearedMemoryCaches: string[];
    } {
        // Clear all memory caches (both namespace and class level)
        const clearedMemoryCaches: string[] = [];
        for (const key of memoryCache.keys()) {
            clearedMemoryCaches.push(key);
        }
        memoryCache.clear();

        // Invalidate file cache entries and their dependents
        const { invalidatedFiles, dependentFiles } = this.invalidateFilesAndDependents(changedFiles, fileCache);

        return {
            invalidatedFiles,
            dependentFiles,
            clearedMemoryCaches
        };
    }

    // ========================================
    // UNIFIED PARTIAL UPDATE STRATEGY
    // ========================================

    /**
     * Unified partial update strategy that handles both namespace and class level updates together
     * This eliminates different update logic and ensures both graphs are always updated together
     */
    static async performUnifiedPartialUpdate(
        changedFilePath: string,
        workspaceRoot: string,
        cacheManager: any,
        incrementalParser: any,
        dependencyAnalyzer: any,
        outputChannel: any
    ): Promise<{
        namespaceResult: any | null;
        classResult: any | null;
        updatePerformed: boolean;
    }> {
        outputChannel.appendLine(`🔄 UNIFIED UPDATE: Processing ${this.getRelativePath(changedFilePath, workspaceRoot)}`);
        
        try {
            // 1. Parse changed file once to get all affected items
            const parseResult = await incrementalParser.parseChangedFile(changedFilePath, workspaceRoot);
            outputChannel.appendLine(`📦 Affected: ${parseResult.namespaceAffected.length} namespaces, ${parseResult.classesAffected.length} classes`);

            // 2. Get both cached results
            const cachedNamespaceResult = await cacheManager.getCachedAnalysis('namespace');
            const cachedClassResult = await cacheManager.getCachedAnalysis('class');

            let namespaceResult = cachedNamespaceResult;
            let classResult = cachedClassResult;
            let updatePerformed = false;

            // 3. Determine if incremental update is feasible
            const allCSharpFiles = await this.getCSharpFiles(workspaceRoot);
            const shouldUseIncremental = this.shouldUseIncrementalUpdate([changedFilePath], allCSharpFiles.length);

            if (!shouldUseIncremental) {
                outputChannel.appendLine(`🔄 Change too significant - performing full analysis`);
                
                // Perform full analysis for both levels
                namespaceResult = await dependencyAnalyzer.analyzeProject(workspaceRoot, 'namespace');
                classResult = await dependencyAnalyzer.analyzeProject(workspaceRoot, 'class');
                
                // Cache both results
                await cacheManager.cacheAnalysis(namespaceResult);
                await cacheManager.cacheAnalysis(classResult);
                
                updatePerformed = true;
            } else if (cachedNamespaceResult && cachedClassResult) {
                outputChannel.appendLine(`⚡ Performing incremental updates for both levels`);
                
                // Perform unified incremental update
                const updateResults = await this.performUnifiedIncrementalUpdate(
                    parseResult,
                    cachedNamespaceResult,
                    cachedClassResult,
                    changedFilePath,
                    workspaceRoot,
                    dependencyAnalyzer,
                    outputChannel
                );

                namespaceResult = updateResults.namespaceResult;
                classResult = updateResults.classResult;

                // Cache both updated results
                await cacheManager.cacheAnalysis(namespaceResult);
                await cacheManager.cacheAnalysis(classResult);
                
                updatePerformed = true;
            } else {
                outputChannel.appendLine(`🔄 Missing cache - performing fresh analysis`);
                
                // One or both caches missing - do full analysis
                namespaceResult = await dependencyAnalyzer.analyzeProject(workspaceRoot, 'namespace');
                classResult = await dependencyAnalyzer.analyzeProject(workspaceRoot, 'class');
                
                // Cache both results
                await cacheManager.cacheAnalysis(namespaceResult);
                await cacheManager.cacheAnalysis(classResult);
                
                updatePerformed = true;
            }

            outputChannel.appendLine(`✅ UNIFIED UPDATE: Complete (namespace: ${namespaceResult?.dependencies.size || 0}, class: ${classResult?.dependencies.size || 0})`);

            return {
                namespaceResult,
                classResult,
                updatePerformed
            };

        } catch (error) {
            outputChannel.appendLine(`❌ UNIFIED UPDATE: Error - ${error}`);
            throw error;
        }
    }

    /**
     * Perform incremental update for both namespace and class levels together
     */
    static async performUnifiedIncrementalUpdate(
        parseResult: any,
        cachedNamespaceResult: any,
        cachedClassResult: any,
        changedFilePath: string,
        workspaceRoot: string,
        dependencyAnalyzer: any,
        outputChannel: any
    ): Promise<{ namespaceResult: any; classResult: any }> {
        
        // 1. Update namespace level
        outputChannel.appendLine(`📦 Updating namespace level: ${parseResult.namespaceAffected.join(', ')}`);
        
        // Remove affected namespaces from cache
        for (const affectedNamespace of parseResult.namespaceAffected) {
            cachedNamespaceResult.dependencies.delete(affectedNamespace);
        }

        // Re-analyze affected namespaces
        if (parseResult.namespaceAffected.length > 0) {
            const freshNamespaceAnalysis = await dependencyAnalyzer.analyzeSpecificNamespaces(
                workspaceRoot,
                parseResult.namespaceAffected,
                cachedNamespaceResult.dependencies
            );

            // Merge back into cache
            for (const [namespace, data] of freshNamespaceAnalysis) {
                if (parseResult.namespaceAffected.includes(namespace)) {
                    cachedNamespaceResult.dependencies.set(namespace, data);
                }
            }
        }

        // 2. Update class level
        outputChannel.appendLine(`🏗️ Updating class level: ${parseResult.classesAffected.join(', ')}`);
        
        // Remove affected classes from cache
        for (const affectedClass of parseResult.classesAffected) {
            cachedClassResult.dependencies.delete(affectedClass);
        }

        // Re-analyze affected classes
        if (parseResult.classesAffected.length > 0) {
            const freshClassAnalysis = await dependencyAnalyzer.analyzeSpecificClasses(
                workspaceRoot,
                parseResult.classesAffected,
                cachedClassResult.dependencies
            );

            // Merge back into cache
            for (const [className, data] of freshClassAnalysis) {
                if (parseResult.classesAffected.includes(className)) {
                    cachedClassResult.dependencies.set(className, data);
                }
            }
        }

        // 3. Update metadata for both results
        const timestamp = new Date();
        cachedNamespaceResult.timestamp = timestamp;
        cachedClassResult.timestamp = timestamp;

        if (!cachedNamespaceResult.affectedFiles.includes(changedFilePath)) {
            cachedNamespaceResult.affectedFiles.push(changedFilePath);
        }
        if (!cachedClassResult.affectedFiles.includes(changedFilePath)) {
            cachedClassResult.affectedFiles.push(changedFilePath);
        }

        return {
            namespaceResult: cachedNamespaceResult,
            classResult: cachedClassResult
        };
    }

    /**
     * Unified circular dependency detection for both analysis levels
     */
    static detectUnifiedCircularDependencies(
        namespaceResult: any,
        classResult: any,
        changedFilePath: string | null,
        parseResult: any | null,
        circularDependencyDetector: any,
        outputChannel: any
    ): { namespaceCircular: any[]; classCircular: any[] } {
        let namespaceCircular: any[] = [];
        let classCircular: any[] = [];

        if (changedFilePath && parseResult) {
            // Incremental circular dependency detection
            outputChannel.appendLine(`🔍 Smart circular dependency detection for affected items`);
            
            if (parseResult.namespaceAffected.length > 0) {
                namespaceCircular = circularDependencyDetector.findCircularDependenciesInSubgraph(
                    namespaceResult.dependencies,
                    parseResult.namespaceAffected
                );
            }

            if (parseResult.classesAffected.length > 0) {
                classCircular = circularDependencyDetector.findCircularDependenciesInSubgraph(
                    classResult.dependencies,
                    parseResult.classesAffected
                );
            }
        } else {
            // Full circular dependency detection
            outputChannel.appendLine(`🔍 Full circular dependency detection`);
            
            namespaceCircular = circularDependencyDetector.findCircularDependencies(
                namespaceResult.dependencies
            );
            classCircular = circularDependencyDetector.findCircularDependencies(
                classResult.dependencies
            );
        }

        outputChannel.appendLine(`🔄 Found circular dependencies: ${namespaceCircular.length} namespace, ${classCircular.length} class`);

        return { namespaceCircular, classCircular };
    }

    /**
     * Smart unified analysis wrapper that leverages metadata-based optimization
     */
    static async performUnifiedAnalysisWrapper(
        workspaceRoot: string,
        cacheManager: any,
        dependencyAnalyzer: any,
        outputChannel: any,
        forceFullAnalysis: boolean = false
    ): Promise<{
        namespaceResult: any;
        classResult: any;
        efficiency: {
            efficiencyRatio: number;
            filesSkipped: number;
            timeSkipped: number;
            totalDuration: number;
            recommendation: string;
        };
        usedOptimization: boolean;
    }> {
        const startTime = Date.now();
        outputChannel.appendLine(`🚀 Starting smart unified analysis...`);

        try {
            // Get file cache and last analysis time
            const fileCache = cacheManager.getFileCache();
            const lastAnalysisTime = cacheManager.getLastAnalysisTime();

            // Smart file scanning to identify changes
            const scanResult = await this.smartAnalyzeChangedFiles(
                workspaceRoot,
                fileCache,
                lastAnalysisTime
            );

            outputChannel.appendLine(
                `📊 Scan Results: ${scanResult.scanMetrics.totalFiles} total, ` +
                `${scanResult.scanMetrics.newFiles} new, ` +
                `${scanResult.scanMetrics.modifiedFiles} modified, ` +
                `${scanResult.scanMetrics.deletedFiles} deleted`
            );

            // Update file metadata cache
            await this.updateFileMetadataCache(
                await this.getCSharpFilesWithMetadata(workspaceRoot),
                fileCache
            );

            const analysisStartTime = Date.now();
            let namespaceResult: any;
            let classResult: any;
            let usedOptimization = false;

            // Determine analysis strategy
            if (forceFullAnalysis || !scanResult.analysisNeeded) {
                if (forceFullAnalysis) {
                    outputChannel.appendLine(`🔄 Force full analysis requested`);
                } else {
                    outputChannel.appendLine(`✅ No changes detected - using cached results`);
                }

                // Get cached results or perform full analysis
                namespaceResult = await cacheManager.getCachedAnalysis('namespace');
                classResult = await cacheManager.getCachedAnalysis('class');

                if (!namespaceResult || !classResult) {
                    outputChannel.appendLine(`🔄 Missing cache - performing full analysis`);
                    namespaceResult = await dependencyAnalyzer.analyzeProject(workspaceRoot, 'namespace');
                    classResult = await dependencyAnalyzer.analyzeProject(workspaceRoot, 'class');
                    
                    await cacheManager.cacheAnalysis(namespaceResult);
                    await cacheManager.cacheAnalysis(classResult);
                }
            } else {
                // Smart incremental analysis
                outputChannel.appendLine(`⚡ Performing smart incremental analysis`);
                usedOptimization = true;

                // Check if we should use incremental or full analysis
                const shouldUseIncremental = this.shouldUseIncrementalUpdate(
                    scanResult.changedFiles,
                    scanResult.scanMetrics.totalFiles
                );

                if (shouldUseIncremental) {
                    // Get cached results
                    const cachedNamespaceResult = await cacheManager.getCachedAnalysis('namespace');
                    const cachedClassResult = await cacheManager.getCachedAnalysis('class');

                    if (cachedNamespaceResult && cachedClassResult) {
                        // Perform optimized incremental updates
                        outputChannel.appendLine(`🔧 Updating ${scanResult.changedFiles.length} changed files`);
                        
                        // Create metadata index for optimization
                        const metadataIndex = this.createFileMetadataIndex(fileCache);
                        
                        // Analyze only changed files with smart dependency detection
                        const incrementalResults = await this.performOptimizedIncrementalAnalysis(
                            scanResult.changedFiles,
                            workspaceRoot,
                            cachedNamespaceResult,
                            cachedClassResult,
                            metadataIndex,
                            dependencyAnalyzer,
                            outputChannel
                        );

                        namespaceResult = incrementalResults.namespaceResult;
                        classResult = incrementalResults.classResult;
                    } else {
                        // Missing cache - fall back to full analysis
                        outputChannel.appendLine(`⚠️ Missing cache - falling back to full analysis`);
                        namespaceResult = await dependencyAnalyzer.analyzeProject(workspaceRoot, 'namespace');
                        classResult = await dependencyAnalyzer.analyzeProject(workspaceRoot, 'class');
                    }
                } else {
                    // Too many changes - perform full analysis
                    outputChannel.appendLine(`📈 Too many changes - performing full analysis`);
                    namespaceResult = await dependencyAnalyzer.analyzeProject(workspaceRoot, 'namespace');
                    classResult = await dependencyAnalyzer.analyzeProject(workspaceRoot, 'class');
                }

                // Cache the results
                await cacheManager.cacheAnalysis(namespaceResult);
                await cacheManager.cacheAnalysis(classResult);
            }

            // Calculate efficiency metrics
            const analysisDuration = Date.now() - analysisStartTime;
            const filesActuallyAnalyzed = usedOptimization ? scanResult.changedFiles.length : scanResult.scanMetrics.totalFiles;
            
            const efficiency = this.calculateAnalysisEfficiency(
                scanResult.scanMetrics.totalFiles,
                filesActuallyAnalyzed,
                scanResult.scanMetrics.scanDuration,
                analysisDuration
            );

            const totalDuration = Date.now() - startTime;
            outputChannel.appendLine(
                `✅ Smart analysis complete in ${this.formatDuration(totalDuration)} ` +
                `(efficiency: ${(efficiency.efficiencyRatio * 100).toFixed(1)}%, ` +
                `${efficiency.recommendation})`
            );

            return {
                namespaceResult,
                classResult,
                efficiency,
                usedOptimization
            };

        } catch (error) {
            outputChannel.appendLine(`❌ Smart analysis failed: ${error}`);
            throw error;
        }
    }

    /**
     * Perform optimized incremental analysis using metadata indexes
     */
    static async performOptimizedIncrementalAnalysis(
        changedFiles: string[],
        workspaceRoot: string,
        cachedNamespaceResult: any,
        cachedClassResult: any,
        metadataIndex: any,
        dependencyAnalyzer: any,
        outputChannel: any
    ): Promise<{ namespaceResult: any; classResult: any }> {
        // Parse changed files to identify affected namespaces and classes
        const allAffectedNamespaces = new Set<string>();
        const allAffectedClasses = new Set<string>();

        for (const filePath of changedFiles) {
            try {
                const content = await this.readFileContent(filePath);
                const parseResult = await this.parseChangedFileIncremental(filePath, content, workspaceRoot);
                
                parseResult.namespaceAffected.forEach(ns => allAffectedNamespaces.add(ns));
                parseResult.classesAffected.forEach(cls => allAffectedClasses.add(cls));
            } catch (error) {
                outputChannel.appendLine(`⚠️ Error parsing ${filePath}: ${error}`);
            }
        }

        // Find files that need to be analyzed using metadata optimization
        const namespacesToCheck = Array.from(allAffectedNamespaces);
        const classesToCheck = Array.from(allAffectedClasses);

        const namespaceFiles = this.getFilesForNamespacesOptimized(namespacesToCheck, metadataIndex);
        const classFiles = this.getFilesForClassesOptimized(classesToCheck, metadataIndex);

        outputChannel.appendLine(
            `🔍 Smart file discovery: ${namespaceFiles.length} namespace files, ` +
            `${classFiles.length} class files (vs scanning all files)`
        );

        // Update cached results by removing affected items
        for (const namespace of allAffectedNamespaces) {
            cachedNamespaceResult.dependencies.delete(namespace);
        }
        for (const className of allAffectedClasses) {
            cachedClassResult.dependencies.delete(className);
        }

        // Re-analyze only the optimized file sets
        if (namespacesToCheck.length > 0) {
            const freshNamespaceAnalysis = await dependencyAnalyzer.analyzeSpecificFiles(
                namespaceFiles,
                workspaceRoot,
                'namespace'
            );
            
            // Merge results
            for (const [key, value] of freshNamespaceAnalysis) {
                cachedNamespaceResult.dependencies.set(key, value);
            }
        }

        if (classesToCheck.length > 0) {
            const freshClassAnalysis = await dependencyAnalyzer.analyzeSpecificFiles(
                classFiles,
                workspaceRoot,
                'class'
            );
            
            // Merge results
            for (const [key, value] of freshClassAnalysis) {
                cachedClassResult.dependencies.set(key, value);
            }
        }

        // Update metadata
        const timestamp = new Date();
        cachedNamespaceResult.timestamp = timestamp;
        cachedClassResult.timestamp = timestamp;

        return {
            namespaceResult: cachedNamespaceResult,
            classResult: cachedClassResult
        };
    }
}