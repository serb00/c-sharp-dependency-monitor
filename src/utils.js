import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
export class Utils {
    /**
     * Get all C# files in a directory recursively
     */
    static async getCSharpFiles(directoryPath) {
        const files = [];
        try {
            const entries = await fs.readdir(directoryPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(directoryPath, entry.name);
                if (entry.isDirectory()) {
                    const subFiles = await this.getCSharpFiles(fullPath);
                    files.push(...subFiles);
                }
                else if (entry.isFile() && entry.name.endsWith('.cs')) {
                    files.push(fullPath);
                }
            }
        }
        catch (error) {
            // Directory doesn't exist or is not accessible
            console.warn(`Could not read directory ${directoryPath}:`, error);
        }
        return files;
    }
    /**
     * Read file content safely
     */
    static async readFileContent(filePath) {
        try {
            return await fs.readFile(filePath, 'utf-8');
        }
        catch (error) {
            throw new Error(`Failed to read file ${filePath}: ${error}`);
        }
    }
    /**
     * Calculate MD5 checksum of file content for caching
     */
    static calculateFileChecksum(content) {
        return crypto.createHash('md5').update(content).digest('hex');
    }
    /**
     * Extract namespace from C# file content
     */
    static extractNamespace(content) {
        const namespaceMatch = content.match(/^namespace\s+([\w.]+)/m);
        return namespaceMatch ? namespaceMatch[1] : null;
    }
    /**
     * Extract using statements from C# file content
     */
    static extractUsingStatements(content) {
        const lines = content.split('\n');
        const usingStatements = [];
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
    static extractQualifiedTypeReferences(content) {
        const lines = content.split('\n');
        const references = [];
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
    static shouldIgnoreNamespace(namespace, ignoredNamespaces) {
        return ignoredNamespaces.some(ignored => namespace.startsWith(ignored));
    }
    /**
     * Convert file path to relative path from workspace root
     */
    static getRelativePath(filePath, workspaceRoot) {
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
    static generateCircularDependencyId(cycle) {
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
    static escapeRegex(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    /**
     * Deep clone an object
     */
    static deepClone(obj) {
        return JSON.parse(JSON.stringify(obj));
    }
    /**
     * Debounce function for file watching
     */
    static debounce(func, wait) {
        let timeout;
        return (...args) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => func(...args), wait);
        };
    }
    /**
     * Get workspace root path
     */
    static getWorkspaceRoot() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        return workspaceFolders?.[0]?.uri.fsPath;
    }
    /**
     * Show error message with optional actions
     */
    static async showErrorMessage(message, ...actions) {
        return vscode.window.showErrorMessage(message, ...actions);
    }
    /**
     * Show info message with optional actions
     */
    static async showInfoMessage(message, ...actions) {
        return vscode.window.showInformationMessage(message, ...actions);
    }
    /**
     * Show warning message with optional actions
     */
    static async showWarningMessage(message, ...actions) {
        return vscode.window.showWarningMessage(message, ...actions);
    }
    /**
     * Format time duration for display
     */
    static formatDuration(milliseconds) {
        if (milliseconds < 1000) {
            return `${milliseconds}ms`;
        }
        else if (milliseconds < 60000) {
            return `${(milliseconds / 1000).toFixed(1)}s`;
        }
        else {
            const minutes = Math.floor(milliseconds / 60000);
            const seconds = Math.floor((milliseconds % 60000) / 1000);
            return `${minutes}m ${seconds}s`;
        }
    }
    /**
     * Check if file exists
     */
    static async fileExists(filePath) {
        try {
            await fs.access(filePath);
            return true;
        }
        catch {
            return false;
        }
    }
}
