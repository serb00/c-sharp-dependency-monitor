import * as vscode from 'vscode';
import { ConfigManager } from './configManager';
import { eventBus, Events } from './eventSystem';
import { Utils } from './utils';
import { AnalysisResult, AnalysisLevel, CircularDependency } from './types';
import { CSharpFileWatcher } from './fileWatcher';
import { DependencyAnalyzer } from './dependencyAnalyzer';
import { CircularDependencyDetector } from './circularDependencyDetector';
import { NotificationManager } from './notificationManager';
import { StatusBarManager } from './statusBarManager';
import { VisualizationPanel } from './visualizationPanel';
import { CacheManager } from './cacheManager';
import { IncrementalParser } from './incrementalParser';

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
let visualizationPanel: VisualizationPanel;
let cacheManager: CacheManager;
let incrementalParser: IncrementalParser;

// Make cache manager globally available for optimization
declare global {
    var cacheManager: CacheManager | undefined;
}

export async function activate(context: vscode.ExtensionContext) {
    extensionContext = context;
    configManager = ConfigManager.getInstance();
    outputChannel = vscode.window.createOutputChannel('C# Dependency Monitor');
    
    console.log('C# Dependency Monitor extension is activating...');
    
    // Initialize core components
    await initializeExtension(context);
    
    // Register commands
    registerCommands(context);
    
    // Setup configuration monitoring
    setupConfigurationMonitoring(context);
    
    // Show activation message
    outputChannel.appendLine('C# Dependency Monitor extension activated successfully');
    console.log('C# Dependency Monitor extension activated successfully');
}

async function initializeExtension(context: vscode.ExtensionContext) {
    const config = configManager.getConfig();
    
    // Initialize core components
    dependencyAnalyzer = new DependencyAnalyzer(outputChannel);
    circularDependencyDetector = new CircularDependencyDetector();
    notificationManager = new NotificationManager(outputChannel);
    statusBarManager = new StatusBarManager();
    cacheManager = new CacheManager(outputChannel);
    visualizationPanel = new VisualizationPanel(outputChannel, cacheManager);
    incrementalParser = new IncrementalParser();
    
    // Add components to disposables
    context.subscriptions.push(statusBarManager);
    context.subscriptions.push({ dispose: () => visualizationPanel.dispose() });
    context.subscriptions.push({ dispose: () => cacheManager.clearCache() });
    
    // Initialize event handlers
    setupEventHandlers();
    
    // Initialize file watcher
    fileWatcher = new CSharpFileWatcher(handleFileChange, outputChannel);
    context.subscriptions.push({ dispose: () => fileWatcher.dispose() });
    
    // Initialize cache manager
    const workspaceRoot = Utils.getWorkspaceRoot();
    if (workspaceRoot) {
        await cacheManager.initialize(workspaceRoot);
        
        // Make cache manager globally available for optimization
        (global as any).cacheManager = cacheManager;
    }

    // Start initial analysis if workspace contains C# files
    if (hasWorkspaceCSharpFiles()) {
        outputChannel.appendLine(`File watcher initialized. Real-time analysis: ${config.enableRealTime ? 'enabled' : 'disabled'}`);
        
        // Show initial statistics
        showFileWatcherStats();
        showCacheStats();
        
        // Load and use cached analysis immediately on startup
        if (workspaceRoot) {
            const cachedAnalysis = await cacheManager.loadStartupCache();
            if (cachedAnalysis) {
                // Detect circular dependencies for cached result
                const circularDependencies = circularDependencyDetector.findCircularDependencies(
                    cachedAnalysis.dependencies
                );
                cachedAnalysis.circularDependencies = circularDependencies;
                
                // Update status bar with cached data
                statusBarManager.updateStatus(cachedAnalysis);
                
                // Process cached results through notification manager
                await notificationManager.processAnalysisResult(cachedAnalysis);
                
                outputChannel.appendLine(`✅ Extension ready with cached data: ${circularDependencies.length} circular dependencies detected`);
            } else {
                outputChannel.appendLine('ℹ️ No cached data available - will analyze on first file change or manual request');
                // Explicitly set status bar to uninitialized state
                statusBarManager.updateStatus(); // This will trigger the uninitialized state since no result is passed
            }
        }
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
            command: 'csharpDependencyMonitor.showCacheStats',
            handler: showCacheStatsCommand
        },
        {
            command: 'csharpDependencyMonitor.exportCacheDebug',
            handler: exportCacheDebugCommand
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
    
    // Listen for visualization requests
    eventBus.on(Events.VISUALIZATION_REQUESTED, async (event) => {
        outputChannel.appendLine('Visualization requested from notification');
        try {
            if (event.data && typeof event.data === 'object' && event.data.dependencies) {
                await visualizationPanel.show(event.data as AnalysisResult);
            } else {
                // If no analysis data provided, run a fresh analysis
                await showVisualizationCommand();
            }
        } catch (error) {
            outputChannel.appendLine(`Error opening visualization from notification: ${error}`);
            await Utils.showErrorMessage(`Failed to open visualization: ${error}`);
        }
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
        
        const analysisResult = await performUnifiedAnalysisWrapper(uri.fsPath, workspaceRoot);
        
        if (!analysisResult) {
            outputChannel.appendLine('⚠️ Cascading analysis returned no results');
            return;
        }
        
        const analysisTime = Date.now() - startTime;
        outputChannel.appendLine(`Analysis completed in ${Utils.formatDuration(analysisTime)} - ${analysisResult.circularDependencies?.length || 0} circular dependencies found`);
        
        // Update status bar
        statusBarManager.updateStatus(analysisResult);
        
        // Update visualization panel if it's open
        if (visualizationPanel.isOpen()) {
            await visualizationPanel.refresh(analysisResult);
        }
        
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

/**
 * Unified analysis wrapper that uses the new unified partial update strategy
 * Replaces the old cascading analysis system
 */
async function performUnifiedAnalysisWrapper(
    changedFilePath: string,
    workspaceRoot: string
): Promise<AnalysisResult | null> {
    try {
        if (changedFilePath) {
            outputChannel.appendLine(`🔄 SMART UNIFIED ANALYSIS: Processing file change with metadata optimization`);
            
            // Use smart unified analysis that leverages metadata-based optimization
            const smartResult = await Utils.performUnifiedAnalysisWrapper(
                workspaceRoot,
                cacheManager,
                dependencyAnalyzer,
                outputChannel,
                false // forceFullAnalysis
            );

            const analysisResult = smartResult.classResult || smartResult.namespaceResult;

            // Log efficiency metrics if available
            if (smartResult.efficiency) {
                const metrics = smartResult.efficiency;
                outputChannel.appendLine(`📈 ANALYSIS EFFICIENCY: ${(metrics.efficiencyRatio * 100).toFixed(1)}% optimization achieved`);
            }
            
            if (analysisResult) {
                // Detect circular dependencies using unified detection
                const circularResults = Utils.detectUnifiedCircularDependencies(
                    smartResult.namespaceResult,
                    smartResult.classResult,
                    changedFilePath,
                    null, // parseResult not needed for full detection
                    circularDependencyDetector,
                    outputChannel
                );
                
                // Use class-level circular dependencies for main result
                analysisResult.circularDependencies = circularResults.classCircular;
            }
            
            return analysisResult;
        } else {
            outputChannel.appendLine('🔄 SMART UNIFIED ANALYSIS: Full project analysis with metadata optimization');
            
            // Use smart unified analysis for full project analysis
            const smartResult = await Utils.performUnifiedAnalysisWrapper(
                workspaceRoot,
                cacheManager,
                dependencyAnalyzer,
                outputChannel,
                false // forceFullAnalysis
            );

            const analysisResult = smartResult.classResult || smartResult.namespaceResult;

            // Log efficiency metrics if available
            if (smartResult.efficiency) {
                const metrics = smartResult.efficiency;
                outputChannel.appendLine(`🎯 STARTUP ANALYSIS EFFICIENCY: ${(metrics.efficiencyRatio * 100).toFixed(1)}% optimization achieved`);
                outputChannel.appendLine(`   Recommendation: ${metrics.recommendation}`);
            }
            
            if (analysisResult) {
                // Detect circular dependencies using unified detection
                const circularResults = Utils.detectUnifiedCircularDependencies(
                    smartResult.namespaceResult,
                    smartResult.classResult,
                    null, // No specific file for full analysis
                    null, // No parse result for full analysis
                    circularDependencyDetector,
                    outputChannel
                );
                
                // Use class-level circular dependencies for main result
                analysisResult.circularDependencies = circularResults.classCircular;
            }
            
            return analysisResult;
        }
    } catch (error) {
        outputChannel.appendLine(`❌ SMART UNIFIED ANALYSIS: Error - ${error}`);
        throw error;
    }
}

// NOTE: Old separate update functions removed - now using unified strategy in Utils.performUnifiedPartialUpdate

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
        
        Utils.showInfoMessage('Starting C# dependency analysis...');
        outputChannel.appendLine('🚀 Manual analysis triggered by user click');
        
        // Emit analysis started event
        eventBus.emit(Events.ANALYSIS_STARTED, {
            type: 'analysis_started',
            data: {
                manual: true,
                trigger: 'manual_command'
            },
            timestamp: new Date()
        });
        
        // Use the SAME unified analysis system as file watcher for consistency
        outputChannel.appendLine('🔄 Using unified analysis system (both levels together)');
        const analysisResult = await performUnifiedAnalysisWrapper('', workspaceRoot);
        
        if (!analysisResult) {
            throw new Error('Cascading analysis failed to produce results');
        }
        
        const analysisTime = Date.now() - startTime;
        const analysisDisplayConfig = configManager.getConfig();
        
        outputChannel.appendLine(`Manual analysis completed in ${Utils.formatDuration(analysisTime)}`);
        outputChannel.appendLine(`Analysis level: ${analysisDisplayConfig.level}`);
        outputChannel.appendLine(`Files analyzed: ${analysisResult.totalFiles}`);
        outputChannel.appendLine(`Dependencies found: ${analysisResult.dependencies.size}`);
        outputChannel.appendLine(`Circular dependencies: ${analysisResult.circularDependencies?.length || 0}`);
        
        // Update status bar
        statusBarManager.updateStatus(analysisResult);
        
        // Update visualization panel if it's open
        if (visualizationPanel.isOpen()) {
            outputChannel.appendLine('🖼️ Refreshing visualization panel with manual analysis data...');
            await visualizationPanel.refresh(analysisResult);
        }
        
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
        
        const workspaceRoot = Utils.getWorkspaceRoot();
        if (!workspaceRoot) {
            await Utils.showErrorMessage('No workspace root found. Please open a C# project.');
            return;
        }
        
        // Always try to use cache first for instant visualization
        const visualizationConfig = configManager.getConfig();
        let analysisResult = await cacheManager.getCachedAnalysis(visualizationConfig.level);
        
        if (!analysisResult) {
            // Only perform analysis if absolutely no cache exists - use NEW UNIFIED SYSTEM
            outputChannel.appendLine('No cache available - using unified analysis for visualization');
            analysisResult = await performUnifiedAnalysisWrapper('', workspaceRoot);
            
            if (!analysisResult) {
                throw new Error('Unified analysis failed to produce results for visualization');
            }
        } else {
            outputChannel.appendLine(`✅ Using cached analysis for instant visualization (${analysisResult.dependencies.size} dependencies)`);
        }
        
        // Detect circular dependencies
        const circularDependencies = circularDependencyDetector.findCircularDependencies(
            analysisResult.dependencies
        );
        
        // Update analysis result
        analysisResult.circularDependencies = circularDependencies;
        
        // Update status bar with the analysis results (this was missing!)
        statusBarManager.updateStatus(analysisResult);
        
        // Show visualization panel
        await visualizationPanel.show(analysisResult);
        
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        outputChannel.appendLine(`Failed to open visualization: ${errorMessage}`);
        await Utils.showErrorMessage(`Failed to open visualization: ${errorMessage}`);
    }
}

async function clearCacheCommand() {
    try {
        outputChannel.appendLine('Clearing dependency analysis cache...');
        
        // Clear all caches
        await cacheManager.clearCache();
        notificationManager.clearNotificationState();
        
        // Update status bar to uninitialized state after cache clear
        // Clear the cached result first, then update
        statusBarManager.clearCachedResult();
        statusBarManager.updateStatus(); // No result parameter = uninitialized state
        
        eventBus.emit(Events.CACHE_CLEARED, {
            type: 'cache_cleared',
            data: {},
            timestamp: new Date()
        });
        
        outputChannel.appendLine('All caches and notification state cleared');
        outputChannel.appendLine('Status bar updated to uninitialized state');
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

function showCacheStats(): void {
    try {
        const stats = cacheManager.getCacheStats();
        outputChannel.appendLine(`Cache statistics:`);
        outputChannel.appendLine(`  - Memory cache: ${JSON.stringify(stats.memoryCache)}`);
        outputChannel.appendLine(`  - File cache: ${stats.fileCache} files`);
        outputChannel.appendLine(`  - Cache size: ${stats.cacheSize}`);
        outputChannel.appendLine(`  - Last update: ${stats.lastUpdate}`);
    } catch (error) {
        outputChannel.appendLine(`Error getting cache stats: ${error}`);
    }
}

async function showCacheStatsCommand() {
    try {
        const stats = cacheManager.getCacheStats();
        const message = `Cache Statistics:\n• Memory Cache: ${JSON.stringify(stats.memoryCache, null, 2)}\n• File Cache: ${stats.fileCache} files\n• Cache Size: ${stats.cacheSize}\n• Last Update: ${stats.lastUpdate}`;
        
        await Utils.showInfoMessage(message);
        outputChannel.appendLine('Cache statistics displayed to user');
        
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await Utils.showErrorMessage(`Failed to get cache stats: ${errorMessage}`);
    }
}

async function exportCacheDebugCommand() {
    try {
        const debugInfo = await cacheManager.exportCacheDebugInfo();
        
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file('cache-debug-info.json'),
            filters: {
                'JSON Files': ['json'],
                'All Files': ['*']
            }
        });

        if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(debugInfo));
            await Utils.showInfoMessage(`Cache debug info exported to ${uri.fsPath}`);
            outputChannel.appendLine(`Cache debug info exported to: ${uri.fsPath}`);
        }
        
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await Utils.showErrorMessage(`Failed to export cache debug info: ${errorMessage}`);
    }
}


export function deactivate() {
    outputChannel.appendLine('C# Dependency Monitor extension deactivated');
    
    // Clean up components
    if (statusBarManager) {
        statusBarManager.dispose();
    }
    if (visualizationPanel) {
        visualizationPanel.dispose();
    }
    
    eventBus.clear();
    outputChannel.dispose();
}
