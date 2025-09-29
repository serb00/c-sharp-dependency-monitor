import * as vscode from 'vscode';
import { ConfigManager } from './configManager';
import { eventBus, Events } from './eventSystem';
import { Utils } from './utils';
import { AnalysisResult } from './types';
import { CSharpFileWatcher } from './fileWatcher';
import { DependencyAnalyzer } from './dependencyAnalyzer';
import { CircularDependencyDetector } from './circularDependencyDetector';
import { NotificationManager } from './notificationManager';
import { StatusBarManager } from './statusBarManager';

/**
 * C# Dependency Monitor Extension
 * Real-time dependency analysis and circular dependency detection for C# projects
 */

let extensionContext: vscode.ExtensionContext;
let configManager: ConfigManager;
let outputChannel: vscode.OutputChannel;
let fileWatcher: CSharpFileWatcher;
let dependencyAnalyzer: DependencyAnalyzer;
let circularDependencyDetector: CircularDependencyDetector;
let notificationManager: NotificationManager;
let statusBarManager: StatusBarManager;

export function activate(context: vscode.ExtensionContext) {
    extensionContext = context;
    configManager = ConfigManager.getInstance();
    outputChannel = vscode.window.createOutputChannel('C# Dependency Monitor');
    
    console.log('C# Dependency Monitor extension is activating...');
    
    // Initialize core components
    initializeExtension(context);
    
    // Register commands
    registerCommands(context);
    
    // Setup configuration monitoring
    setupConfigurationMonitoring(context);
    
    // Show activation message
    outputChannel.appendLine('C# Dependency Monitor extension activated successfully');
    console.log('C# Dependency Monitor extension activated successfully');
}

function initializeExtension(context: vscode.ExtensionContext) {
    const config = configManager.getConfig();
    
    // Initialize core components
    dependencyAnalyzer = new DependencyAnalyzer();
    circularDependencyDetector = new CircularDependencyDetector();
    notificationManager = new NotificationManager(outputChannel);
    statusBarManager = new StatusBarManager();
    
    // Add status bar to disposables
    context.subscriptions.push(statusBarManager);
    
    // Initialize event handlers
    setupEventHandlers();
    
    // Initialize file watcher
    fileWatcher = new CSharpFileWatcher(handleFileChange, outputChannel);
    context.subscriptions.push({ dispose: () => fileWatcher.dispose() });
    
    // Start initial analysis if workspace contains C# files
    if (hasWorkspaceCSharpFiles()) {
        outputChannel.appendLine(`File watcher initialized. Real-time analysis: ${config.enableRealTime ? 'enabled' : 'disabled'}`);
        
        // Show initial statistics
        showFileWatcherStats();
    } else {
        outputChannel.appendLine('No C# workspace detected');
    }
}

function registerCommands(context: vscode.ExtensionContext) {
    // Register all extension commands
    const commands = [
        {
            command: 'csharpDependencyMonitor.analyzeProject',
            handler: analyzeProjectCommand
        },
        {
            command: 'csharpDependencyMonitor.showVisualization',
            handler: showVisualizationCommand
        },
        {
            command: 'csharpDependencyMonitor.clearCache',
            handler: clearCacheCommand
        },
        {
            command: 'csharpDependencyMonitor.toggleRealTimeAnalysis',
            handler: toggleRealTimeAnalysisCommand
        }
    ];

    commands.forEach(({ command, handler }) => {
        const disposable = vscode.commands.registerCommand(command, handler);
        context.subscriptions.push(disposable);
    });
}

function setupConfigurationMonitoring(context: vscode.ExtensionContext) {
    const configDisposable = configManager.onConfigChange((newConfig) => {
        outputChannel.appendLine(`Configuration changed: ${JSON.stringify(newConfig, null, 2)}`);
        eventBus.emit(Events.CONFIG_CHANGED, {
            type: 'config_changed',
            data: newConfig,
            timestamp: new Date()
        });
    });
    
    context.subscriptions.push(configDisposable);
}

function setupEventHandlers() {
    // Listen for analysis events
    eventBus.on(Events.ANALYSIS_COMPLETED, (event) => {
        outputChannel.appendLine(`Analysis completed: ${event.data.totalFiles} files analyzed`);
    });
    
    eventBus.on(Events.CIRCULAR_DEPENDENCY_FOUND, (event) => {
        outputChannel.appendLine(`Circular dependency detected: ${event.data.cycle?.join(' → ')}`);
    });
    
    eventBus.on(Events.ANALYSIS_ERROR, (event) => {
        outputChannel.appendLine(`Analysis error: ${event.data.error}`);
        console.error('Analysis error:', event.data);
    });
}

function hasWorkspaceCSharpFiles(): boolean {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return false;
    }
    
    // Check if any workspace folder has typical C# project structure
    for (const folder of workspaceFolders) {
        const folderPath = folder.uri.fsPath;
        // Look for common C# project indicators
        if (folderPath.includes('Scripts') ||
            folderPath.includes('src') ||
            folderPath.includes('Source') ||
            folderPath.includes('Assets')) {
            return true;
        }
    }
    
    return true; // Default to true for now
}

async function handleFileChange(uri: vscode.Uri, changeType: 'create' | 'change' | 'delete'): Promise<void> {
    try {
        const startTime = Date.now();
        outputChannel.appendLine(`Handling ${changeType} for: ${Utils.getRelativePath(uri.fsPath)}`);
        
        // Get workspace root for analysis
        const workspaceRoot = Utils.getWorkspaceRoot();
        if (!workspaceRoot) {
            outputChannel.appendLine('No workspace root found, skipping analysis');
            return;
        }
        
        // Perform dependency analysis
        outputChannel.appendLine('Starting dependency analysis...');
        eventBus.emit(Events.ANALYSIS_STARTED, {
            type: 'analysis_started',
            data: {
                filePath: uri.fsPath,
                changeType,
                trigger: 'file_change'
            },
            timestamp: new Date()
        });
        
        const analysisResult = await dependencyAnalyzer.analyzeProject(workspaceRoot);
        
        // Detect circular dependencies
        const circularDependencies = circularDependencyDetector.findCircularDependencies(
            analysisResult.dependencies
        );
        
        // Update analysis result with circular dependencies
        analysisResult.circularDependencies = circularDependencies;
        
        const analysisTime = Date.now() - startTime;
        outputChannel.appendLine(`Analysis completed in ${Utils.formatDuration(analysisTime)}`);
        outputChannel.appendLine(`Found ${circularDependencies.length} circular dependencies`);
        
        // Update status bar
        statusBarManager.updateStatus(analysisResult);
        
        // Process results through notification manager
        await notificationManager.processAnalysisResult(analysisResult);
        
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        outputChannel.appendLine(`Error handling file change: ${errorMessage}`);
        
        eventBus.emit(Events.ANALYSIS_ERROR, {
            type: 'error',
            data: {
                error: errorMessage,
                filePath: uri.fsPath,
                changeType
            },
            timestamp: new Date()
        });
        
        await Utils.showErrorMessage(`Dependency analysis failed: ${errorMessage}`);
    }
}

async function showFileWatcherStats(): Promise<void> {
    try {
        const stats = await fileWatcher.getWatchedFilesStats();
        outputChannel.appendLine(`File watcher statistics:`);
        outputChannel.appendLine(`  - Active: ${stats.isActive}`);
        outputChannel.appendLine(`  - Total C# files: ${stats.totalFiles}`);
        outputChannel.appendLine(`  - Watched paths: ${stats.watchedPaths.length}`);
        for (const path of stats.watchedPaths) {
            outputChannel.appendLine(`    • ${Utils.getRelativePath(path)}`);
        }
    } catch (error) {
        outputChannel.appendLine(`Error getting file watcher stats: ${error}`);
    }
}

// Command handlers
async function analyzeProjectCommand() {
    try {
        const startTime = Date.now();
        outputChannel.appendLine('Manual project analysis started...');
        
        const workspaceRoot = Utils.getWorkspaceRoot();
        if (!workspaceRoot) {
            await Utils.showErrorMessage('No workspace root found. Please open a C# project.');
            return;
        }
        
        await Utils.showInfoMessage('Starting C# dependency analysis...');
        
        // Emit analysis started event
        eventBus.emit(Events.ANALYSIS_STARTED, {
            type: 'analysis_started',
            data: {
                manual: true,
                trigger: 'manual_command'
            },
            timestamp: new Date()
        });
        
        // Perform full project analysis
        const analysisResult = await dependencyAnalyzer.analyzeProject(workspaceRoot);
        
        // Detect circular dependencies
        const circularDependencies = circularDependencyDetector.findCircularDependencies(
            analysisResult.dependencies
        );
        
        // Update analysis result
        analysisResult.circularDependencies = circularDependencies;
        
        const analysisTime = Date.now() - startTime;
        const config = configManager.getConfig();
        
        outputChannel.appendLine(`Manual analysis completed in ${Utils.formatDuration(analysisTime)}`);
        outputChannel.appendLine(`Analysis level: ${config.level}`);
        outputChannel.appendLine(`Files analyzed: ${analysisResult.totalFiles}`);
        outputChannel.appendLine(`Dependencies found: ${analysisResult.dependencies.size}`);
        outputChannel.appendLine(`Circular dependencies: ${circularDependencies.length}`);
        
        // Update status bar
        statusBarManager.updateStatus(analysisResult);
        
        // Process results through notification manager
        await notificationManager.processAnalysisResult(analysisResult);
        
        // Show quick status
        await notificationManager.showQuickStatus(analysisResult);
        
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        outputChannel.appendLine(`Manual analysis failed: ${errorMessage}`);
        await Utils.showErrorMessage(`Analysis failed: ${errorMessage}`);
        
        eventBus.emit(Events.ANALYSIS_ERROR, {
            type: 'error',
            data: {
                error: errorMessage,
                manual: true
            },
            timestamp: new Date()
        });
    }
}

async function showVisualizationCommand() {
    try {
        outputChannel.appendLine('Opening dependency visualization...');
        // TODO: Implement visualization panel
        await Utils.showInfoMessage('Visualization panel coming soon!');
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await Utils.showErrorMessage(`Failed to open visualization: ${errorMessage}`);
    }
}

async function clearCacheCommand() {
    try {
        outputChannel.appendLine('Clearing dependency analysis cache...');
        
        // Clear notification state
        notificationManager.clearNotificationState();
        
        eventBus.emit(Events.CACHE_CLEARED, {
            type: 'cache_cleared',
            data: {},
            timestamp: new Date()
        });
        
        outputChannel.appendLine('Cache and notification state cleared');
        await Utils.showInfoMessage('Cache cleared successfully!');
        
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await Utils.showErrorMessage(`Failed to clear cache: ${errorMessage}`);
    }
}

async function toggleRealTimeAnalysisCommand() {
    try {
        const config = configManager.getConfig();
        const newValue = !config.enableRealTime;
        
        await configManager.updateConfig('enableRealTimeAnalysis', newValue);
        
        const message = newValue ? 'Real-time analysis enabled' : 'Real-time analysis disabled';
        outputChannel.appendLine(message);
        await Utils.showInfoMessage(message);
        
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await Utils.showErrorMessage(`Failed to toggle real-time analysis: ${errorMessage}`);
    }
}

export function deactivate() {
    outputChannel.appendLine('C# Dependency Monitor extension deactivated');
    
    // Clean up components
    if (statusBarManager) {
        statusBarManager.dispose();
    }
    
    eventBus.clear();
    outputChannel.dispose();
}
