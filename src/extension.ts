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
    dependencyAnalyzer = new DependencyAnalyzer();
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
        
        const analysisResult = await performIncrementalCascadingAnalysis(uri.fsPath, workspaceRoot);
        
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
 * Performs cascading analysis: namespace → class → system
 * Stops at first level where circular dependencies are found
 */
async function performIncrementalCascadingAnalysis(
    changedFilePath: string,
    workspaceRoot: string
): Promise<AnalysisResult | null> {
    outputChannel.appendLine(`Analyzing: ${Utils.getRelativePath(changedFilePath)}`);
    
    // 1. NAMESPACE LEVEL (fastest)
    const namespaceResult = await analyzeNamespaceLevel(workspaceRoot, changedFilePath);
    
    if (namespaceResult && namespaceResult.circularDependencies && namespaceResult.circularDependencies.length > 0) {
        outputChannel.appendLine(`Found ${namespaceResult.circularDependencies.length} circular dependencies at namespace level`);
        return namespaceResult;
    }
    
    // 2. CLASS LEVEL (more detailed)
    const classResult = await analyzeClassLevel(workspaceRoot, changedFilePath);
    
    if (classResult && classResult.circularDependencies && classResult.circularDependencies.length > 0) {
        outputChannel.appendLine(`Found ${classResult.circularDependencies.length} circular dependencies at class level`);
        return classResult;
    }
    
    // 3. SYSTEM LEVEL (most specific)
    const systemResult = await analyzeSystemLevel(workspaceRoot, changedFilePath);
    
    if (systemResult && systemResult.circularDependencies && systemResult.circularDependencies.length > 0) {
        outputChannel.appendLine(`Found ${systemResult.circularDependencies.length} circular dependencies at system level`);
        return systemResult;
    }
    
    // Return the most detailed analysis (system level) even if no circular deps found
    return systemResult || classResult || namespaceResult;
}

/**
 * Analyze dependencies at namespace level using INCREMENTAL analysis
 */
async function analyzeNamespaceLevel(workspaceRoot: string, changedFilePath?: string): Promise<AnalysisResult | null> {
    try {
        let analysisResult = await cacheManager.getCachedAnalysis('namespace');
        
        if (!analysisResult || !changedFilePath) {
            analysisResult = await dependencyAnalyzer.analyzeProject(workspaceRoot, 'namespace');
            await cacheManager.cacheAnalysis(analysisResult);
        } else {
            analysisResult = await updateNamespaceCache(analysisResult, changedFilePath, workspaceRoot);
        }
        
        // Detect circular dependencies using smart subgraph checking for incremental updates
        let circularDependencies: CircularDependency[];
        if (changedFilePath) {
            // Get affected objects for smart circular dependency checking
            const parseResult = await incrementalParser.parseChangedFile(changedFilePath, workspaceRoot);
            if (parseResult.namespaceAffected.length > 0) {
                circularDependencies = circularDependencyDetector.findCircularDependenciesInSubgraph(
                    analysisResult.dependencies,
                    parseResult.namespaceAffected
                );
            } else {
                circularDependencies = [];
            }
        } else {
            // Full analysis - check entire graph
            circularDependencies = circularDependencyDetector.findCircularDependencies(
                analysisResult.dependencies
            );
        }
        analysisResult.circularDependencies = circularDependencies;
        
        return analysisResult;
    } catch (error) {
        outputChannel.appendLine(`Error in namespace analysis: ${error}`);
        return null;
    }
}

/**
 * Analyze dependencies at class level using INCREMENTAL analysis
 */
async function analyzeClassLevel(workspaceRoot: string, changedFilePath?: string): Promise<AnalysisResult | null> {
    try {
        let analysisResult = await cacheManager.getCachedAnalysis('class');
        
        if (!analysisResult || !changedFilePath) {
            analysisResult = await dependencyAnalyzer.analyzeProject(workspaceRoot, 'class');
            await cacheManager.cacheAnalysis(analysisResult);
        } else {
            analysisResult = await updateClassCache(analysisResult, changedFilePath, workspaceRoot);
        }
        
        // Detect circular dependencies using smart subgraph checking for incremental updates
        let circularDependencies: CircularDependency[];
        if (changedFilePath) {
            // Get affected objects for smart circular dependency checking
            const parseResult = await incrementalParser.parseChangedFile(changedFilePath, workspaceRoot);
            if (parseResult.classesAffected.length > 0) {
                circularDependencies = circularDependencyDetector.findCircularDependenciesInSubgraph(
                    analysisResult.dependencies,
                    parseResult.classesAffected
                );
            } else {
                circularDependencies = [];
            }
        } else {
            // Full analysis - check entire graph
            circularDependencies = circularDependencyDetector.findCircularDependencies(
                analysisResult.dependencies
            );
        }
        analysisResult.circularDependencies = circularDependencies;
        
        return analysisResult;
    } catch (error) {
        outputChannel.appendLine(`Error in class analysis: ${error}`);
        return null;
    }
}

/**
 * Analyze dependencies at system level using INCREMENTAL analysis
 */
async function analyzeSystemLevel(workspaceRoot: string, changedFilePath?: string): Promise<AnalysisResult | null> {
    try {
        let analysisResult = await cacheManager.getCachedAnalysis('system');
        
        if (!analysisResult || !changedFilePath) {
            analysisResult = await dependencyAnalyzer.analyzeProject(workspaceRoot, 'system');
            await cacheManager.cacheAnalysis(analysisResult);
        } else {
            analysisResult = await updateSystemCache(analysisResult, changedFilePath, workspaceRoot);
        }
        
        // Detect circular dependencies using smart subgraph checking for incremental updates
        let circularDependencies: CircularDependency[];
        if (changedFilePath) {
            // Get affected objects for smart circular dependency checking
            const parseResult = await incrementalParser.parseChangedFile(changedFilePath, workspaceRoot);
            if (parseResult.systemsAffected.length > 0) {
                circularDependencies = circularDependencyDetector.findCircularDependenciesInSubgraph(
                    analysisResult.dependencies,
                    parseResult.systemsAffected
                );
            } else {
                circularDependencies = [];
            }
        } else {
            // Full analysis - check entire graph
            circularDependencies = circularDependencyDetector.findCircularDependencies(
                analysisResult.dependencies
            );
        }
        analysisResult.circularDependencies = circularDependencies;
        
        return analysisResult;
    } catch (error) {
        outputChannel.appendLine(`Error in system analysis: ${error}`);
        return null;
    }
}

/**
 * Update namespace cache with COMPLETE NAMESPACE analysis - TRUE incremental analysis
 *
 * CRITICAL: For namespace analysis, we must analyze ALL files in affected namespaces
 * because a single namespace can span multiple files and we need complete dependency picture
 */
async function updateNamespaceCache(
    cachedResult: AnalysisResult,
    changedFilePath: string,
    workspaceRoot: string
): Promise<AnalysisResult> {
    outputChannel.appendLine(`🔍 Incrementally updating NAMESPACE cache for: ${Utils.getRelativePath(changedFilePath)}`);
    
    // 1. Parse changed file to identify affected namespaces
    const parseResult = await incrementalParser.parseChangedFile(changedFilePath, workspaceRoot);
    outputChannel.appendLine(`📦 Found ${parseResult.namespaceAffected.length} affected namespaces: ${parseResult.namespaceAffected.join(', ')}`);
    
    // 2. For each affected namespace, analyze ALL files in that namespace (not just changed file)
    for (const affectedNamespace of parseResult.namespaceAffected) {
        outputChannel.appendLine(`🔍 Re-analyzing COMPLETE namespace: ${affectedNamespace}`);
        
        // Remove old namespace entry
        cachedResult.dependencies.delete(affectedNamespace);
        
        // PERFORMANCE OPTIMIZATION: Use incremental analysis instead of full project scan
        outputChannel.appendLine(`🚀 PERFORMANCE OPTIMIZATION: Using incremental namespace analysis for ${parseResult.namespaceAffected.length} affected namespaces`);
        const startIncrementalAnalysis = Date.now();
        const completeNamespaceAnalysis = await dependencyAnalyzer.analyzeSpecificNamespaces(
            workspaceRoot,
            parseResult.namespaceAffected,
            cachedResult.dependencies
        );
        const incrementalAnalysisTime = Date.now() - startIncrementalAnalysis;
        outputChannel.appendLine(`⚡ INCREMENTAL ANALYSIS took ${Utils.formatDuration(incrementalAnalysisTime)} - much faster than full project scan!`);
        
        // Add only the affected namespace back to cache
        if (completeNamespaceAnalysis.has(affectedNamespace)) {
            const namespaceDep = completeNamespaceAnalysis.get(affectedNamespace)!;
            cachedResult.dependencies.set(affectedNamespace, namespaceDep);
            outputChannel.appendLine(`📦 Updated namespace: ${affectedNamespace} (${namespaceDep.dependencies.length} dependencies)`);
        } else {
            outputChannel.appendLine(`📦 Removed namespace: ${affectedNamespace} (no dependencies found)`);
        }
    }
    
    // Update metadata
    cachedResult.timestamp = new Date();
    if (!cachedResult.affectedFiles.includes(changedFilePath)) {
        cachedResult.affectedFiles.push(changedFilePath);
    }
    
    // Cache the updated result
    await cacheManager.cacheAnalysis(cachedResult);
    
    return cachedResult;
}

/**
 * Update class cache with COMPLETE AFFECTED CLASSES analysis - TRUE incremental analysis
 *
 * CRITICAL: For class analysis, if class A changes, we need to re-analyze ALL classes that
 * might reference class A, not just class A itself
 */
async function updateClassCache(
    cachedResult: AnalysisResult,
    changedFilePath: string,
    workspaceRoot: string
): Promise<AnalysisResult> {
    outputChannel.appendLine(`🔍 Incrementally updating CLASS cache for: ${Utils.getRelativePath(changedFilePath)}`);
    
    // 1. Parse changed file to identify affected classes
    const parseResult = await incrementalParser.parseChangedFile(changedFilePath, workspaceRoot);
    outputChannel.appendLine(`🏗️ Found ${parseResult.classesAffected.length} affected classes: ${parseResult.classesAffected.join(', ')}`);
    
    // 2. For affected classes, get fresh COMPLETE class analysis
    // This ensures we catch all references from other files
    outputChannel.appendLine(`🔍 Re-analyzing COMPLETE class dependencies for affected classes`);
    
    // Remove affected classes from cache
    for (const affectedClass of parseResult.classesAffected) {
        cachedResult.dependencies.delete(affectedClass);
    }
    
    // PERFORMANCE OPTIMIZATION: Use incremental analysis instead of full project scan
    outputChannel.appendLine(`🚀 PERFORMANCE OPTIMIZATION: Using incremental class analysis for ${parseResult.classesAffected.length} affected classes`);
    const startIncrementalAnalysis = Date.now();
    const completeClassAnalysis = await dependencyAnalyzer.analyzeSpecificClasses(
        workspaceRoot,
        parseResult.classesAffected,
        cachedResult.dependencies
    );
    const incrementalAnalysisTime = Date.now() - startIncrementalAnalysis;
    outputChannel.appendLine(`⚡ INCREMENTAL ANALYSIS took ${Utils.formatDuration(incrementalAnalysisTime)} - much faster than full project scan!`);
    
    // Add back only the affected classes with complete analysis
    for (const affectedClass of parseResult.classesAffected) {
        if (completeClassAnalysis.has(affectedClass)) {
            const classDep = completeClassAnalysis.get(affectedClass)!;
            cachedResult.dependencies.set(affectedClass, classDep);
            outputChannel.appendLine(`🏗️ Updated class: ${affectedClass} (${classDep.dependencies.length} dependencies)`);
        } else {
            outputChannel.appendLine(`🏗️ Removed class: ${affectedClass} (no dependencies found)`);
        }
    }
    
    // Update metadata
    cachedResult.timestamp = new Date();
    if (!cachedResult.affectedFiles.includes(changedFilePath)) {
        cachedResult.affectedFiles.push(changedFilePath);
    }
    
    // Cache the updated result
    await cacheManager.cacheAnalysis(cachedResult);
    
    return cachedResult;
}

/**
 * Update system cache with COMPLETE AFFECTED SYSTEMS analysis - TRUE incremental analysis
 *
 * CRITICAL: For system analysis, if system A changes, we need to re-analyze ALL systems that
 * might reference system A, not just system A itself
 */
async function updateSystemCache(
    cachedResult: AnalysisResult,
    changedFilePath: string,
    workspaceRoot: string
): Promise<AnalysisResult> {
    outputChannel.appendLine(`🔍 Incrementally updating SYSTEM cache for: ${Utils.getRelativePath(changedFilePath)}`);
    
    // 1. Parse changed file to identify affected systems
    const parseResult = await incrementalParser.parseChangedFile(changedFilePath, workspaceRoot);
    outputChannel.appendLine(`⚙️ Found ${parseResult.systemsAffected.length} affected systems: ${parseResult.systemsAffected.join(', ')}`);
    
    // 2. For affected systems, get fresh COMPLETE system analysis
    // This ensures we catch all references from other files
    outputChannel.appendLine(`🔍 Re-analyzing COMPLETE system dependencies for affected systems`);
    
    // Remove affected systems from cache
    for (const affectedSystem of parseResult.systemsAffected) {
        cachedResult.dependencies.delete(affectedSystem);
    }
    
    // PERFORMANCE OPTIMIZATION: Use incremental analysis instead of full project scan
    outputChannel.appendLine(`🚀 PERFORMANCE OPTIMIZATION: Using incremental system analysis for ${parseResult.systemsAffected.length} affected systems`);
    const startIncrementalAnalysis = Date.now();
    const completeSystemAnalysis = await dependencyAnalyzer.analyzeSpecificSystems(
        workspaceRoot,
        parseResult.systemsAffected,
        cachedResult.dependencies
    );
    const incrementalAnalysisTime = Date.now() - startIncrementalAnalysis;
    outputChannel.appendLine(`⚡ INCREMENTAL ANALYSIS took ${Utils.formatDuration(incrementalAnalysisTime)} - much faster than full project scan!`);
    
    // Add back only the affected systems with complete analysis
    for (const affectedSystem of parseResult.systemsAffected) {
        if (completeSystemAnalysis.has(affectedSystem)) {
            const systemDep = completeSystemAnalysis.get(affectedSystem)!;
            cachedResult.dependencies.set(affectedSystem, systemDep);
            outputChannel.appendLine(`⚙️ Updated system: ${affectedSystem} (${systemDep.dependencies.length} dependencies)`);
        } else {
            outputChannel.appendLine(`⚙️ Removed system: ${affectedSystem} (no dependencies found)`);
        }
    }
    
    // Update metadata
    cachedResult.timestamp = new Date();
    if (!cachedResult.affectedFiles.includes(changedFilePath)) {
        cachedResult.affectedFiles.push(changedFilePath);
    }
    
    // Cache the updated result
    await cacheManager.cacheAnalysis(cachedResult);
    
    return cachedResult;
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
        
        // Check cache first
        const config = configManager.getConfig();
        let analysisResult = await cacheManager.getCachedAnalysis(config.level);
        
        if (!analysisResult) {
            // Cache miss - perform full project analysis
            outputChannel.appendLine('Cache miss - performing full analysis');
            analysisResult = await dependencyAnalyzer.analyzeProject(workspaceRoot);
            
            // Cache the new result
            await cacheManager.cacheAnalysis(analysisResult);
        } else {
            outputChannel.appendLine('Using cached analysis result');
        }
        
        // Detect circular dependencies - use full analysis for visualization
        const circularDependencies = circularDependencyDetector.findCircularDependencies(
            analysisResult.dependencies
        );
        
        // Update analysis result
        analysisResult.circularDependencies = circularDependencies;
        
        const analysisTime = Date.now() - startTime;
        const analysisDisplayConfig = configManager.getConfig();
        
        outputChannel.appendLine(`Manual analysis completed in ${Utils.formatDuration(analysisTime)}`);
        outputChannel.appendLine(`Analysis level: ${analysisDisplayConfig.level}`);
        outputChannel.appendLine(`Files analyzed: ${analysisResult.totalFiles}`);
        outputChannel.appendLine(`Dependencies found: ${analysisResult.dependencies.size}`);
        outputChannel.appendLine(`Circular dependencies: ${circularDependencies.length}`);
        
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
            // Only perform analysis if absolutely no cache exists
            outputChannel.appendLine('No cache available - performing fresh analysis for visualization');
            analysisResult = await dependencyAnalyzer.analyzeProject(workspaceRoot);
            
            // Cache the new result
            await cacheManager.cacheAnalysis(analysisResult);
        } else {
            outputChannel.appendLine(`✅ Using cached analysis for instant visualization (${analysisResult.dependencies.size} dependencies)`);
        }
        
        // Detect circular dependencies
        const circularDependencies = circularDependencyDetector.findCircularDependencies(
            analysisResult.dependencies
        );
        
        // Update analysis result
        analysisResult.circularDependencies = circularDependencies;
        
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
        
        eventBus.emit(Events.CACHE_CLEARED, {
            type: 'cache_cleared',
            data: {},
            timestamp: new Date()
        });
        
        outputChannel.appendLine('All caches and notification state cleared');
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
