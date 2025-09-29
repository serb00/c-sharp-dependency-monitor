import * as vscode from 'vscode';
import { AnalysisResult, CircularDependency } from './types';
import { Utils } from './utils';
import { ConfigManager } from './configManager';
import { eventBus, Events } from './eventSystem';

export class StatusBarManager {
    private statusBarItem: vscode.StatusBarItem;
    private configManager: ConfigManager;
    private lastAnalysisResult: AnalysisResult | undefined;
    private isAnalyzing: boolean = false;

    constructor() {
        this.configManager = ConfigManager.getInstance();
        
        // Create status bar item
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100 // Priority - higher numbers appear more to the left
        );
        
        // Set up initial state
        this.setupStatusBarItem();
        this.setupEventListeners();
        
        // Show the status bar item
        this.statusBarItem.show();
    }

    /**
     * Initialize the status bar item with default properties
     */
    private setupStatusBarItem(): void {
        this.statusBarItem.command = 'csharpDependencyMonitor.analyzeProject';
        this.statusBarItem.tooltip = 'C# Dependency Monitor - Click to analyze project';
        this.updateStatus(); // Set initial status
    }

    /**
     * Set up event listeners for analysis events
     */
    private setupEventListeners(): void {
        // Listen for analysis events
        eventBus.on(Events.ANALYSIS_STARTED, () => {
            this.isAnalyzing = true;
            this.updateStatus();
        });

        eventBus.on(Events.ANALYSIS_COMPLETED, (event) => {
            this.isAnalyzing = false;
            if (event.data && typeof event.data === 'object') {
                // Create a mock analysis result from the event data
                const mockResult: Partial<AnalysisResult> = {
                    circularDependencies: [],
                    totalFiles: event.data.totalFiles || 0,
                    timestamp: new Date()
                };

                // Add circular dependencies if available
                if (event.data.totalCircular) {
                    const mockCircular: CircularDependency[] = [];
                    for (let i = 0; i < event.data.totalCircular; i++) {
                        mockCircular.push({
                            cycle: [],
                            edges: [],
                            isNew: i < (event.data.newCircular || 0),
                            discovered: new Date(),
                            id: `mock-${i}`
                        });
                    }
                    mockResult.circularDependencies = mockCircular;
                }

                this.updateStatusFromEventData(mockResult as AnalysisResult);
            } else {
                this.updateStatus();
            }
        });

        eventBus.on(Events.ANALYSIS_ERROR, () => {
            this.isAnalyzing = false;
            this.updateStatusError();
        });

        eventBus.on(Events.CIRCULAR_DEPENDENCY_FOUND, () => {
            this.updateStatus(); // Refresh status when new circular dependencies are found
        });

        eventBus.on(Events.CIRCULAR_DEPENDENCY_RESOLVED, () => {
            this.updateStatus(); // Refresh status when circular dependencies are resolved
        });

        // Listen for configuration changes
        this.configManager.onConfigChange(() => {
            this.updateStatus();
        });
    }

    /**
     * Update status bar with analysis results
     */
    public updateStatus(analysisResult?: AnalysisResult): void {
        if (analysisResult) {
            this.lastAnalysisResult = analysisResult;
        }

        const config = this.configManager.getConfig();
        const result = analysisResult || this.lastAnalysisResult;

        if (this.isAnalyzing) {
            this.statusBarItem.text = '$(sync~spin) C# Deps: Analyzing...';
            this.statusBarItem.tooltip = 'C# Dependency Analysis in progress...';
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            return;
        }

        if (!result) {
            // No analysis results yet
            this.statusBarItem.text = '$(search) C# Deps: Ready';
            this.statusBarItem.tooltip = `C# Dependency Monitor - Analysis Level: ${config.level}\nReal-time: ${config.enableRealTime ? 'On' : 'Off'}\nClick to analyze project`;
            this.statusBarItem.backgroundColor = undefined;
            return;
        }

        const circularCount = result.circularDependencies.length;
        const newCount = result.circularDependencies.filter(cd => cd.isNew).length;
        const totalFiles = result.totalFiles;

        if (circularCount === 0) {
            // Healthy state - no circular dependencies
            this.statusBarItem.text = '$(check) C# Deps: Healthy';
            this.statusBarItem.tooltip = this.buildHealthyTooltip(result, config);
            this.statusBarItem.backgroundColor = undefined;
        } else if (newCount === 0) {
            // Known issues - no new problems
            this.statusBarItem.text = `$(warning) C# Deps: ${circularCount} known`;
            this.statusBarItem.tooltip = this.buildKnownIssuestooltip(result, config);
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            // New issues detected
            this.statusBarItem.text = `$(error) C# Deps: ${newCount} new, ${circularCount} total`;
            this.statusBarItem.tooltip = this.buildNewIssuestooltip(result, config);
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        }
    }

    /**
     * Update status from event data (for events that don't have full AnalysisResult)
     */
    private updateStatusFromEventData(eventData: AnalysisResult): void {
        this.updateStatus(eventData);
    }

    /**
     * Update status bar to show error state
     */
    private updateStatusError(): void {
        this.statusBarItem.text = '$(alert) C# Deps: Error';
        this.statusBarItem.tooltip = 'C# Dependency Analysis failed - Check output panel for details\nClick to retry analysis';
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }

    /**
     * Build tooltip for healthy state
     */
    private buildHealthyTooltip(result: AnalysisResult, config: any): string {
        const lines = [
            '✅ C# Dependencies: All Clear!',
            '',
            `📁 Files analyzed: ${result.totalFiles}`,
            `🔍 Analysis level: ${config.level}`,
            `⚡ Real-time monitoring: ${config.enableRealTime ? 'On' : 'Off'}`,
            `🔔 Notifications: ${config.enableNotifications ? 'On' : 'Off'}`,
            '',
            `📊 Dependencies found: ${result.dependencies?.size || 0}`,
            '🎯 No circular dependencies detected',
            '',
            `⏱️ Last analysis: ${this.formatTimestamp(result.timestamp)}`,
            '',
            'Click to run manual analysis'
        ];
        return lines.join('\n');
    }

    /**
     * Build tooltip for known issues state
     */
    private buildKnownIssuestooltip(result: AnalysisResult, config: any): string {
        const circularCount = result.circularDependencies.length;
        const lines = [
            `⚠️ C# Dependencies: ${circularCount} Known Issues`,
            '',
            `📁 Files analyzed: ${result.totalFiles}`,
            `🔍 Analysis level: ${config.level}`,
            `⚡ Real-time monitoring: ${config.enableRealTime ? 'On' : 'Off'}`,
            '',
            `📊 Dependencies found: ${result.dependencies?.size || 0}`,
            `🔄 Circular dependencies: ${circularCount} (no new issues)`,
            '',
            'Circular Dependencies:'
        ];

        // Add up to 3 circular dependencies to the tooltip
        const displayCount = Math.min(3, circularCount);
        for (let i = 0; i < displayCount; i++) {
            const circular = result.circularDependencies[i];
            const cycleDisplay = circular.cycle.join(' → ');
            lines.push(`  • ${cycleDisplay}`);
        }

        if (circularCount > 3) {
            lines.push(`  • ...and ${circularCount - 3} more`);
        }

        lines.push('');
        lines.push(`⏱️ Last analysis: ${this.formatTimestamp(result.timestamp)}`);
        lines.push('');
        lines.push('Click to run manual analysis');

        return lines.join('\n');
    }

    /**
     * Build tooltip for new issues state
     */
    private buildNewIssuestooltip(result: AnalysisResult, config: any): string {
        const circularCount = result.circularDependencies.length;
        const newCount = result.circularDependencies.filter(cd => cd.isNew).length;
        
        const lines = [
            `🚨 C# Dependencies: ${newCount} NEW Issues!`,
            '',
            `📁 Files analyzed: ${result.totalFiles}`,
            `🔍 Analysis level: ${config.level}`,
            `⚡ Real-time monitoring: ${config.enableRealTime ? 'On' : 'Off'}`,
            '',
            `📊 Dependencies found: ${result.dependencies?.size || 0}`,
            `🔄 Circular dependencies: ${circularCount} total (${newCount} new)`,
            '',
            'NEW Circular Dependencies:'
        ];

        // Add new circular dependencies to the tooltip
        const newCircular = result.circularDependencies.filter(cd => cd.isNew);
        const displayCount = Math.min(3, newCount);
        
        for (let i = 0; i < displayCount; i++) {
            const circular = newCircular[i];
            const cycleDisplay = circular.cycle.join(' → ');
            lines.push(`  🆕 ${cycleDisplay}`);
        }

        if (newCount > 3) {
            lines.push(`  • ...and ${newCount - 3} more new issues`);
        }

        lines.push('');
        lines.push(`⏱️ Last analysis: ${this.formatTimestamp(result.timestamp)}`);
        lines.push('');
        lines.push('Click to run manual analysis');

        return lines.join('\n');
    }

    /**
     * Format timestamp for display
     */
    private formatTimestamp(timestamp: Date): string {
        const now = new Date();
        const diffMs = now.getTime() - timestamp.getTime();
        
        if (diffMs < 60000) { // Less than 1 minute
            return 'Just now';
        } else if (diffMs < 3600000) { // Less than 1 hour
            const minutes = Math.floor(diffMs / 60000);
            return `${minutes}m ago`;
        } else if (diffMs < 86400000) { // Less than 1 day
            const hours = Math.floor(diffMs / 3600000);
            return `${hours}h ago`;
        } else {
            return timestamp.toLocaleDateString();
        }
    }

    /**
     * Show analysis in progress state
     */
    public showAnalyzing(): void {
        this.isAnalyzing = true;
        this.updateStatus();
    }

    /**
     * Hide analysis in progress state
     */
    public hideAnalyzing(): void {
        this.isAnalyzing = false;
        this.updateStatus();
    }

    /**
     * Get current status bar statistics
     */
    public getStatusBarStats(): {
        isVisible: boolean;
        isAnalyzing: boolean;
        hasResults: boolean;
        lastAnalysisTime?: Date;
    } {
        return {
            isVisible: this.statusBarItem !== undefined,
            isAnalyzing: this.isAnalyzing,
            hasResults: this.lastAnalysisResult !== undefined,
            lastAnalysisTime: this.lastAnalysisResult?.timestamp
        };
    }

    /**
     * Force a status bar refresh
     */
    public refresh(): void {
        this.updateStatus();
    }

    /**
     * Temporarily highlight the status bar (for important events)
     */
    public async highlightStatusBar(duration: number = 2000): Promise<void> {
        const originalColor = this.statusBarItem.backgroundColor;
        
        // Flash the status bar
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
        
        setTimeout(() => {
            this.statusBarItem.backgroundColor = originalColor;
        }, duration);
    }

    /**
     * Update the command associated with the status bar item
     */
    public setCommand(command: string): void {
        this.statusBarItem.command = command;
    }

    /**
     * Dispose of the status bar item
     */
    public dispose(): void {
        this.statusBarItem.dispose();
    }
}