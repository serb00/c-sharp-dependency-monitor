import * as vscode from 'vscode';
import { 
    CircularDependency, 
    AnalysisResult, 
    NotificationEvent 
} from './types';
import { Utils } from './utils';
import { ConfigManager } from './configManager';
import { eventBus, Events } from './eventSystem';
import { CircularDependencyDetector } from './circularDependencyDetector';

export class NotificationManager {
    private configManager: ConfigManager;
    private circularDependencyDetector: CircularDependencyDetector;
    private knownCircularDependencies: Set<string> = new Set();
    private lastAnalysisResult: AnalysisResult | undefined;
    private outputChannel: vscode.OutputChannel;
    
    constructor(outputChannel: vscode.OutputChannel) {
        this.configManager = ConfigManager.getInstance();
        this.circularDependencyDetector = new CircularDependencyDetector();
        this.outputChannel = outputChannel;
        
        // Setup event listeners
        this.setupEventListeners();
    }

    /**
     * Process new analysis results and notify about NEW circular dependencies
     */
    public async processAnalysisResult(newResult: AnalysisResult): Promise<void> {
        const config = this.configManager.getConfig();
        
        if (!config.enableNotifications) {
            return;
        }

        try {
            // Compare with previous results to identify new circular dependencies
            const previousCircular = this.lastAnalysisResult?.circularDependencies || [];
            const updatedCircular = this.circularDependencyDetector.markNewCircularDependencies(
                newResult.circularDependencies,
                previousCircular
            );

            // Update the result with marked circular dependencies
            newResult.circularDependencies = updatedCircular;

            // Get only new circular dependencies
            const newCircularDependencies = updatedCircular.filter(cd => cd.isNew);

            // Notify about new circular dependencies
            if (newCircularDependencies.length > 0) {
                await this.notifyNewCircularDependencies(newCircularDependencies, newResult);
            }

            // Check if any circular dependencies were resolved
            const resolvedCircular = this.findResolvedCircularDependencies(previousCircular, updatedCircular);
            if (resolvedCircular.length > 0) {
                await this.notifyResolvedCircularDependencies(resolvedCircular);
            }

            // Update known circular dependencies
            this.updateKnownCircularDependencies(updatedCircular);
            this.lastAnalysisResult = newResult;

            // Emit analysis completion event
            eventBus.emit(Events.ANALYSIS_COMPLETED, {
                type: 'analysis_complete',
                data: {
                    totalFiles: newResult.totalFiles,
                    totalCircular: updatedCircular.length,
                    newCircular: newCircularDependencies.length,
                    resolvedCircular: resolvedCircular.length,
                    analysisLevel: newResult.analysisLevel
                },
                timestamp: new Date()
            });

        } catch (error) {
            this.outputChannel.appendLine(`Error processing analysis results: ${error}`);
            console.error('Error processing analysis results:', error);

            eventBus.emit(Events.ANALYSIS_ERROR, {
                type: 'error',
                data: { 
                    error: error instanceof Error ? error.message : 'Unknown error',
                    context: 'notification_processing'
                },
                timestamp: new Date()
            });
        }
    }

    /**
     * Notify about new circular dependencies with detailed information
     */
    private async notifyNewCircularDependencies(
        newCircular: CircularDependency[], 
        analysisResult: AnalysisResult
    ): Promise<void> {
        this.outputChannel.appendLine(`🔴 Found ${newCircular.length} new circular dependencies:`);

        for (const circular of newCircular) {
            const cycleDisplay = circular.cycle.join(' → ');
            this.outputChannel.appendLine(`  • ${cycleDisplay}`);

            // Emit individual circular dependency events
            eventBus.emit(Events.CIRCULAR_DEPENDENCY_FOUND, {
                type: 'circular_dependency_found',
                data: {
                    cycle: circular.cycle,
                    edges: circular.edges,
                    id: circular.id,
                    discovered: circular.discovered
                },
                timestamp: new Date()
            });
        }

        // Show summary notification
        if (newCircular.length === 1) {
            const circular = newCircular[0];
            const cycleDisplay = circular.cycle.join(' → ');
            
            const action = await vscode.window.showWarningMessage(
                `🔴 New circular dependency detected: ${cycleDisplay}`,
                'Show Details',
                'Show Graph',
                'Suggest Fixes',
                'Dismiss'
            );

            await this.handleNotificationAction(action, circular, analysisResult);
        } else {
            const action = await vscode.window.showWarningMessage(
                `🔴 ${newCircular.length} new circular dependencies detected`,
                'Show All Details',
                'Show Graph',
                'Show Summary',
                'Dismiss'
            );

            await this.handleMultipleCircularAction(action, newCircular, analysisResult);
        }
    }

    /**
     * Notify about resolved circular dependencies
     */
    private async notifyResolvedCircularDependencies(resolved: CircularDependency[]): Promise<void> {
        this.outputChannel.appendLine(`✅ Resolved ${resolved.length} circular dependencies:`);

        for (const circular of resolved) {
            const cycleDisplay = circular.cycle.join(' → ');
            this.outputChannel.appendLine(`  • ${cycleDisplay}`);

            eventBus.emit(Events.CIRCULAR_DEPENDENCY_RESOLVED, {
                type: 'analysis_complete',
                data: {
                    cycle: circular.cycle,
                    id: circular.id,
                    resolvedAt: new Date()
                },
                timestamp: new Date()
            });
        }

        if (resolved.length > 0) {
            await vscode.window.showInformationMessage(
                `✅ Great! ${resolved.length} circular ${resolved.length === 1 ? 'dependency' : 'dependencies'} resolved`
            );
        }
    }

    /**
     * Handle user actions from notification buttons
     */
    private async handleNotificationAction(
        action: string | undefined, 
        circular: CircularDependency, 
        analysisResult: AnalysisResult
    ): Promise<void> {
        switch (action) {
            case 'Show Details':
                await this.showCircularDependencyDetails(circular, analysisResult);
                break;
            case 'Show Graph':
                await this.showDependencyGraph(analysisResult);
                break;
            case 'Suggest Fixes':
                await this.showFixSuggestions(circular, analysisResult);
                break;
        }
    }

    /**
     * Handle actions for multiple circular dependencies
     */
    private async handleMultipleCircularAction(
        action: string | undefined,
        circularList: CircularDependency[],
        analysisResult: AnalysisResult
    ): Promise<void> {
        switch (action) {
            case 'Show All Details':
                await this.showAllCircularDetails(circularList, analysisResult);
                break;
            case 'Show Graph':
                await this.showDependencyGraph(analysisResult);
                break;
            case 'Show Summary':
                await this.showCircularDependencySummary(circularList);
                break;
        }
    }

    /**
     * Show detailed information about a specific circular dependency
     */
    private async showCircularDependencyDetails(
        circular: CircularDependency, 
        analysisResult: AnalysisResult
    ): Promise<void> {
        const details = this.circularDependencyDetector.getCircularDependencyDetails(
            circular, 
            analysisResult.dependencies
        );

        const detailLines = [
            `🔴 Circular Dependency Details`,
            ``,
            `Cycle: ${details.cycle}`,
            `Total Edges: ${details.totalEdges}`,
            ``,
            `Detailed Breakdown:`
        ];

        for (const reason of details.detailedReasons) {
            detailLines.push(`  ${reason.from} → ${reason.to}:`);
            for (const reasonText of reason.reasons) {
                detailLines.push(`    • ${reasonText}`);
            }
            detailLines.push('');
        }

        const document = await vscode.workspace.openTextDocument({
            content: detailLines.join('\n'),
            language: 'markdown'
        });

        await vscode.window.showTextDocument(document);
    }

    /**
     * Show summary of all circular dependencies
     */
    private async showCircularDependencySummary(circularList: CircularDependency[]): Promise<void> {
        const stats = this.circularDependencyDetector.getCircularDependencyStats(circularList);
        
        const summaryLines = [
            `🔴 Circular Dependencies Summary`,
            ``,
            `Total Circular Dependencies: ${stats.totalCircular}`,
            `New Dependencies: ${stats.newCircular}`,
            `Affected Nodes: ${stats.affectedNodes}`,
            `Average Cycle Length: ${stats.averageCycleLength.toFixed(1)}`,
            `Longest Cycle: ${stats.longestCycle}`,
            ``,
            `Cycle Length Distribution:`
        ];

        for (const [length, count] of stats.cycleLengthDistribution) {
            summaryLines.push(`  ${length} nodes: ${count} cycles`);
        }

        summaryLines.push('', 'Individual Cycles:');
        
        for (const circular of circularList) {
            const cycleDisplay = circular.cycle.join(' → ');
            summaryLines.push(`  • ${cycleDisplay} ${circular.isNew ? '(NEW)' : ''}`);
        }

        const document = await vscode.workspace.openTextDocument({
            content: summaryLines.join('\n'),
            language: 'markdown'
        });

        await vscode.window.showTextDocument(document);
    }

    /**
     * Show all circular dependency details
     */
    private async showAllCircularDetails(
        circularList: CircularDependency[], 
        analysisResult: AnalysisResult
    ): Promise<void> {
        const allDetails: string[] = [`🔴 All Circular Dependencies (${circularList.length})`, ''];

        for (let i = 0; i < circularList.length; i++) {
            const circular = circularList[i];
            const details = this.circularDependencyDetector.getCircularDependencyDetails(
                circular, 
                analysisResult.dependencies
            );

            allDetails.push(`## ${i + 1}. ${details.cycle} ${circular.isNew ? '(NEW)' : ''}`);
            allDetails.push('');

            for (const reason of details.detailedReasons) {
                allDetails.push(`**${reason.from} → ${reason.to}:**`);
                for (const reasonText of reason.reasons) {
                    allDetails.push(`  - ${reasonText}`);
                }
                allDetails.push('');
            }
        }

        const document = await vscode.workspace.openTextDocument({
            content: allDetails.join('\n'),
            language: 'markdown'
        });

        await vscode.window.showTextDocument(document);
    }

    /**
     * Show fix suggestions for a circular dependency
     */
    private async showFixSuggestions(
        circular: CircularDependency, 
        analysisResult: AnalysisResult
    ): Promise<void> {
        const suggestions = this.circularDependencyDetector.suggestCircularDependencyFixes(
            circular, 
            analysisResult.dependencies
        );

        const suggestionsLines = [
            `🛠️ Fix Suggestions for Circular Dependency`,
            ``,
            `Cycle: ${circular.cycle.join(' → ')}`,
            ``,
            `Recommended Solutions:`
        ];

        for (let i = 0; i < suggestions.length; i++) {
            const suggestion = suggestions[i];
            suggestionsLines.push(`  ${i + 1}. **${suggestion.type.replace(/_/g, ' ').toUpperCase()}** (${suggestion.priority} priority)`);
            suggestionsLines.push(`     ${suggestion.description}`);
            suggestionsLines.push(`     Affected files: ${suggestion.affectedFiles.map(f => Utils.getRelativePath(f)).join(', ')}`);
            suggestionsLines.push('');
        }

        const document = await vscode.workspace.openTextDocument({
            content: suggestionsLines.join('\n'),
            language: 'markdown'
        });

        await vscode.window.showTextDocument(document);
    }

    /**
     * Request to show dependency graph
     */
    private async showDependencyGraph(analysisResult: AnalysisResult): Promise<void> {
        eventBus.emit(Events.VISUALIZATION_REQUESTED, {
            type: 'analysis_complete',
            data: analysisResult,
            timestamp: new Date()
        });

        // The visualization will be handled by the extension's event listener
        // No need to show a placeholder message anymore
    }

    /**
     * Find circular dependencies that were resolved since last analysis
     */
    private findResolvedCircularDependencies(
        previous: CircularDependency[], 
        current: CircularDependency[]
    ): CircularDependency[] {
        const currentIds = new Set(current.map(cd => cd.id));
        return previous.filter(cd => !currentIds.has(cd.id));
    }

    /**
     * Update the set of known circular dependencies
     */
    private updateKnownCircularDependencies(circularDependencies: CircularDependency[]): void {
        this.knownCircularDependencies.clear();
        for (const circular of circularDependencies) {
            this.knownCircularDependencies.add(circular.id);
        }
    }

    /**
     * Setup event listeners for configuration changes and other events
     */
    private setupEventListeners(): void {
        this.configManager.onConfigChange((newConfig) => {
            if (newConfig.enableNotifications) {
                this.outputChannel.appendLine('Notifications enabled');
            } else {
                this.outputChannel.appendLine('Notifications disabled');
            }
        });
    }

    /**
     * Get current notification statistics
     */
    public getNotificationStats(): {
        knownCircularCount: number;
        lastAnalysisTime: Date | undefined;
        notificationsEnabled: boolean;
    } {
        return {
            knownCircularCount: this.knownCircularDependencies.size,
            lastAnalysisTime: this.lastAnalysisResult?.timestamp,
            notificationsEnabled: this.configManager.getConfig().enableNotifications
        };
    }

    /**
     * Clear notification state (useful for testing or manual reset)
     */
    public clearNotificationState(): void {
        this.knownCircularDependencies.clear();
        this.lastAnalysisResult = undefined;
        this.outputChannel.appendLine('Notification state cleared');
    }

    /**
     * Show a quick status notification
     */
    public async showQuickStatus(analysisResult: AnalysisResult): Promise<void> {
        const circularCount = analysisResult.circularDependencies.length;
        const newCount = analysisResult.circularDependencies.filter(cd => cd.isNew).length;
        
        if (circularCount === 0) {
            await vscode.window.showInformationMessage(
                `✅ Analysis complete: No circular dependencies found in ${analysisResult.totalFiles} files`
            );
        } else if (newCount === 0) {
            // Only show notification if there are no new issues (to avoid spam)
            this.outputChannel.appendLine(
                `Analysis complete: ${circularCount} known circular dependencies, no new issues`
            );
        }
    }
}