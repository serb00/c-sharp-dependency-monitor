import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

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
}