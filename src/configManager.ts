import * as vscode from 'vscode';
import { AnalysisConfig, AnalysisLevel } from './types';

export class ConfigManager {
    private static instance: ConfigManager;
    
    public static getInstance(): ConfigManager {
        if (!ConfigManager.instance) {
            ConfigManager.instance = new ConfigManager();
        }
        return ConfigManager.instance;
    }

    private constructor() {}

    public getConfig(): AnalysisConfig {
        const config = vscode.workspace.getConfiguration('csharpDependencyMonitor');
        
        return {
            level: config.get<AnalysisLevel>('analysisLevel', 'namespace'),
            ignoredNamespaces: config.get<string[]>('ignoredNamespaces', ['System', 'Unity', 'UnityEngine']),
            projectPaths: config.get<string[]>('projectPaths', ['Assets/Scripts', 'Scripts', 'src', 'Source']),
            enableRealTime: config.get<boolean>('enableRealTimeAnalysis', true),
            enableNotifications: config.get<boolean>('enableNotifications', true)
        };
    }

    public async updateConfig(key: string, value: any, configurationTarget?: vscode.ConfigurationTarget): Promise<void> {
        const config = vscode.workspace.getConfiguration('csharpDependencyMonitor');
        await config.update(key, value, configurationTarget);
    }

    public onConfigChange(callback: (config: AnalysisConfig) => void): vscode.Disposable {
        return vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('csharpDependencyMonitor')) {
                callback(this.getConfig());
            }
        });
    }

    public getWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
        return vscode.workspace.workspaceFolders || [];
    }

    public findCSharpProjects(): string[] {
        const workspaceFolders = this.getWorkspaceFolders();
        const config = this.getConfig();
        const projects: string[] = [];

        for (const folder of workspaceFolders) {
            for (const projectPath of config.projectPaths) {
                const fullPath = vscode.Uri.joinPath(folder.uri, projectPath).fsPath;
                projects.push(fullPath);
            }
        }

        return projects;
    }

    public shouldIgnoreNamespace(namespace: string): boolean {
        const config = this.getConfig();
        return config.ignoredNamespaces.some(ignored => 
            namespace.startsWith(ignored)
        );
    }

    public isValidCSharpProject(folderPath: string): boolean {
        // Check if folder contains any .cs files or is in our configured project paths
        // This is a simple check - we could make it more sophisticated later
        return true;
    }
}