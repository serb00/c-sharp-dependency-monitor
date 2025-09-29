import * as vscode from 'vscode';
import { Utils } from './utils';
import { eventBus, Events } from './eventSystem';
import { ConfigManager } from './configManager';

export class CSharpFileWatcher {
    private watcher: vscode.FileSystemWatcher | undefined;
    private configManager: ConfigManager;
    private isEnabled: boolean = false;
    private debouncedAnalysis: (...args: any[]) => void;
    private outputChannel: vscode.OutputChannel;

    constructor(
        private onFileChanged: (uri: vscode.Uri, changeType: 'create' | 'change' | 'delete') => Promise<void>,
        outputChannel: vscode.OutputChannel
    ) {
        this.configManager = ConfigManager.getInstance();
        this.outputChannel = outputChannel;
        
        // Debounce file change events to avoid excessive analysis
        this.debouncedAnalysis = Utils.debounce(this.handleDebouncedChange.bind(this), 500);
        
        // Initialize based on current configuration
        const config = this.configManager.getConfig();
        if (config.enableRealTime) {
            this.start();
        }
        
        // Listen for configuration changes
        this.setupConfigurationListener();
    }

    public start(): void {
        if (this.isEnabled || !vscode.workspace.workspaceFolders) {
            return;
        }

        try {
            // Create file system watcher for C# files
            this.watcher = vscode.workspace.createFileSystemWatcher('**/*.cs');
            
            // Setup event handlers
            this.setupEventHandlers();
            
            this.isEnabled = true;
            this.outputChannel.appendLine('File watcher started - monitoring C# files for changes');
            
            eventBus.emit(Events.ANALYSIS_STARTED, {
                type: 'analysis_started',
                data: { source: 'file_watcher', action: 'started' },
                timestamp: new Date()
            });
            
        } catch (error) {
            this.outputChannel.appendLine(`Failed to start file watcher: ${error}`);
            console.error('Failed to start file watcher:', error);
        }
    }

    public stop(): void {
        if (!this.isEnabled || !this.watcher) {
            return;
        }

        try {
            this.watcher.dispose();
            this.watcher = undefined;
            this.isEnabled = false;
            
            this.outputChannel.appendLine('File watcher stopped');
            
            eventBus.emit(Events.ANALYSIS_STARTED, {
                type: 'analysis_started',
                data: { source: 'file_watcher', action: 'stopped' },
                timestamp: new Date()
            });
            
        } catch (error) {
            this.outputChannel.appendLine(`Failed to stop file watcher: ${error}`);
            console.error('Failed to stop file watcher:', error);
        }
    }

    public isActive(): boolean {
        return this.isEnabled;
    }

    public dispose(): void {
        this.stop();
    }

    private setupEventHandlers(): void {
        if (!this.watcher) {
            return;
        }

        // File created
        this.watcher.onDidCreate((uri) => {
            this.outputChannel.appendLine(`C# file created: ${Utils.getRelativePath(uri.fsPath)}`);
            this.debouncedAnalysis(uri, 'create');
        });

        // File changed
        this.watcher.onDidChange((uri) => {
            this.outputChannel.appendLine(`C# file modified: ${Utils.getRelativePath(uri.fsPath)}`);
            this.debouncedAnalysis(uri, 'change');
        });

        // File deleted
        this.watcher.onDidDelete((uri) => {
            this.outputChannel.appendLine(`C# file deleted: ${Utils.getRelativePath(uri.fsPath)}`);
            this.debouncedAnalysis(uri, 'delete');
        });
    }

    private async handleDebouncedChange(uri: vscode.Uri, changeType: 'create' | 'change' | 'delete'): Promise<void> {
        try {
            // Check if the file is in one of our configured project paths
            if (!this.isFileInProjectPath(uri.fsPath)) {
                return;
            }

            // Emit file change event
            eventBus.emit(Events.FILE_CHANGED, {
                type: 'analysis_started',
                data: { 
                    filePath: uri.fsPath,
                    changeType,
                    relativePath: Utils.getRelativePath(uri.fsPath)
                },
                timestamp: new Date()
            });

            // Trigger analysis callback
            await this.onFileChanged(uri, changeType);
            
        } catch (error) {
            this.outputChannel.appendLine(`Error handling file change: ${error}`);
            console.error('Error handling file change:', error);
            
            eventBus.emit(Events.ANALYSIS_ERROR, {
                type: 'error',
                data: { 
                    error: error instanceof Error ? error.message : 'Unknown error',
                    filePath: uri.fsPath,
                    changeType
                },
                timestamp: new Date()
            });
        }
    }

    private isFileInProjectPath(filePath: string): boolean {
        const config = this.configManager.getConfig();
        const workspaceFolders = this.configManager.getWorkspaceFolders();
        
        for (const folder of workspaceFolders) {
            for (const projectPath of config.projectPaths) {
                const fullProjectPath = vscode.Uri.joinPath(folder.uri, projectPath).fsPath;
                if (filePath.startsWith(fullProjectPath)) {
                    return true;
                }
            }
        }
        
        return false;
    }

    private setupConfigurationListener(): void {
        this.configManager.onConfigChange((newConfig) => {
            if (newConfig.enableRealTime && !this.isEnabled) {
                this.start();
            } else if (!newConfig.enableRealTime && this.isEnabled) {
                this.stop();
            }
        });
    }

    /**
     * Get statistics about watched files
     */
    public async getWatchedFilesStats(): Promise<{
        totalFiles: number;
        watchedPaths: string[];
        isActive: boolean;
    }> {
        const config = this.configManager.getConfig();
        const workspaceFolders = this.configManager.getWorkspaceFolders();
        const watchedPaths: string[] = [];
        let totalFiles = 0;

        for (const folder of workspaceFolders) {
            for (const projectPath of config.projectPaths) {
                const fullProjectPath = vscode.Uri.joinPath(folder.uri, projectPath).fsPath;
                watchedPaths.push(fullProjectPath);
                
                try {
                    const files = await Utils.getCSharpFiles(fullProjectPath);
                    totalFiles += files.length;
                } catch (error) {
                    // Path might not exist, which is fine
                }
            }
        }

        return {
            totalFiles,
            watchedPaths,
            isActive: this.isActive()
        };
    }

    /**
     * Force a scan of all watched directories
     */
    public async scanAllWatchedFiles(): Promise<string[]> {
        const config = this.configManager.getConfig();
        const workspaceFolders = this.configManager.getWorkspaceFolders();
        const allFiles: string[] = [];

        for (const folder of workspaceFolders) {
            for (const projectPath of config.projectPaths) {
                const fullProjectPath = vscode.Uri.joinPath(folder.uri, projectPath).fsPath;
                
                try {
                    const files = await Utils.getCSharpFiles(fullProjectPath);
                    allFiles.push(...files);
                } catch (error) {
                    this.outputChannel.appendLine(`Could not scan directory ${fullProjectPath}: ${error}`);
                }
            }
        }

        this.outputChannel.appendLine(`Found ${allFiles.length} C# files in watched directories`);
        return allFiles;
    }
}